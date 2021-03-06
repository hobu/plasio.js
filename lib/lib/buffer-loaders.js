/* @flow */

// buffer-loaders.js
// Load stuff from remote buffers
//

var util = require("./util");
var _ = require("lodash");
import { Promise } from 'bluebird';

import { BaseLoader } from "./base-loader";
import { GeoTransform } from "./geotransform";
import { ClampSelector } from "./brush";
import { BrushFactory } from "./brush-factory";
import { PointBufferCache } from "./point-buffer-cache";
import { GenericWorkerQueue } from "./generic-worker-queue";

import { Device } from "./device";

class BufferLoader extends GenericWorkerQueue {
    constructor(loaderCount) {
        super("buffer-loader", loaderCount, window.PLASIO_WEB_WORKER_PATH || "lib/dist/plasio.webworker.js")
    }

    handleResponse(data, resolve, reject) {
        const success = data.success;
        const buffer = data.buffer;
        const numPoints = data.numPoints;
        const stats = data.stats;

        if (success) {
            resolve({
                buffer: buffer,
                stats: stats,
                numPoints: numPoints
            });
        }
        else {
            reject(new Error('Could not decompress buffer'));
        }
    }

    handleNewRequest(params) {
        const server = util.checkParam(params, 'server', null);
        const resource = util.checkParam(params, 'resource', null);
        const eptRootUrl = util.checkParam(params, 'eptRootUrl', null);

        if (eptRootUrl == null && (server == null || resource == null)) {
            throw new Error('handleNewRequest failed, either the EPT root URL needs to be provided or the server and resource keys should be valid');
        }

        util.checkParam(params, 'bounds');
        util.checkParam(params, 'fullGeoBounds');
        util.checkParam(params, 'scale');
        util.checkParam(params, 'offset');
        util.checkParam(params, 'allowCreds');
        util.checkParam(params, 'schema');
        util.checkParam(params, 'sourceSchema');
        util.checkParam(params, 'weight');
        util.checkParam(params, 'depthBegin');
        util.checkParam(params, 'depthEnd');

        return {
            params: params,
            transferList: []
        };
    }
}

const black = [0,0,0];
const loader = new BufferLoader(Device.caps().loaderCount);
let   pointCloudBufferStats = {};

/**
 * A buffer loader which loads buffers from greyhound/entwine backend
 * @extends BaseLoader
 */
export class GreyhoundPipelineLoader extends BaseLoader {
    /**
     * A static field describing a namespace for this loader.
     * @return {string}
     */
    static get key() {
        return "greyhound";
    }

    /**
     * A static field describing the kind of data this loader provides.  Values can be 'point-buffer'
     * or 'transform'
     * @return {string}
     */
    static get provides() {
        return "point-buffer";
    }

    /**
     * Construct an instance of a point buffer loader.
     * @param resourceConfig {object} The resource to connect to details
     * @param resourceConfig.server {String} When using a Greyhound resource, the server address.
     * @param resourceConfig.resource {String} When using a Grehound resource, the name of the resource to be loaded.
     * @param resourceConfig.eptRootUrl {String} If the resource is an EPT resource, the URL of the base location.
     * @param schema {object} Schema definition
     * @param params Buffer loader initialization parameters.
     * @param params.brushes {BaseBrush[]} An array of brush specifications.
     * @param [params.eptDataStorage] {String} The data storage being used for EPT
     * @param [params.eptHierarchyStep] {Number} When available, the hierarchy step at which the EPT tree chunks hierarchy json files.
     * @param [params.allowGreyhoundCredentials] {boolean} Whether to send credentials when making HTTP queries. Defaults to false.
     * @param [params.key] {String} A unique identifier for buffers loaded using this loader.  This key is used to set buffer visibility.
     * @param [params.filter] {object} A JSON object specifying the filter to use. Defaults to no filter.
     */
    constructor(resourceConfig, schema, params) {
        super();

        const brushes = util.checkParam(params, 'brushes');
        const allowGreyhoundCreds = util.checkParam(params, 'allowGreyhoundCredentials', false);
        const filter = util.checkParam(params, 'filter', null);
        const key = util.checkParam(params, 'key');
        let eptDataStorage, resource, server;

        if (resourceConfig.eptRootUrl) {
            this.eptRootUrl = resourceConfig.eptRootUrl;
            this.isEPTResource =true;

            eptDataStorage = util.checkParam(params, 'eptDataStorage');
        }
        else {
            server = util.checkParam(resourceConfig, 'server');
            resource = util.checkParam(resourceConfig, 'resource');

            this.server = server;
            this.resource = resource;
        }

        this.brushes = [null, null, null, null];
        this.compressed = true;
        this.sourceSchema = schema;
        this.allowGreyhoundCreds = allowGreyhoundCreds;
        this.filter = filter;
        this.eptDataStorage = eptDataStorage;
        this.key = key;

        // set all of the loaders
        brushes.map((brush, i) => {
            this.setColorChannelBrush(i, brush);
        });

        if (this.compressed)
            console.log("Compressed buffers have been requested, make sure laz-perf is available, or you'd see errors.");

        if (!this.compressed)
            throw new Error('Uncompressed buffers are not supported.');
    }

    static _buildSchema(schema, brushes) {
        // basic attributes if supported
        const availableFields = new Map(schema.map(s => [s.name.toLowerCase(), s]));
        const neededFields = new Set(["x", "y", "z"]);

        // if a loader needs additional items get those in as well
        brushes.forEach((brush) => {
            if (brush != null) {
                const brushSchemaItems = brush.requiredSchemaFields();

                // only add these entries if all fields are available
                if (brushSchemaItems.every(item => availableFields.has(item.toLowerCase()))) {
                    brushSchemaItems.forEach(item => neededFields.add(item.toLowerCase()));
                }
            }
        });


        return Array.from(neededFields).map(field => {
            const fieldDesc = Object.assign({}, availableFields.get(field));
            if (fieldDesc.size === 8)
                fieldDesc.size = 4;

            return fieldDesc;
        });
    }

    static _schemaHasColor(schema) {
        // if all three color channels exist in schema, we decide it has color
        const allNames = new Set(schema.map(s => s.name.toLowerCase()));
        return allNames.has('red') && allNames.has('green') && allNames.has('blue');
    }

    static _decomposePoint(buf, off, schema) {
        let r = {};
        schema.forEach((s, i) => {
            r[s.name.toLowerCase()] = buf[off + i];
        });

        return r;
    }

    static _createPointDecomposer(schema) {
        let r = {};
        let offsets = [];
        schemy.forEach((s, i) => {
            let field = s.name.toLowerCase();
            let offset = i;

            offsets.push([field, offset]);
        });

        let totalItems = schema.length;

        return function(buff, off) {
            for (var i = 0 ; i < totalItems ; i++) {
                r[offsets[i][0]] = buff[off + offsets[i][1]];
            }

            return r;
        }
    }

    /**
     * Is this point loader associated with an EPT resource?
     *
     * @return {Boolean} True of false.
     */
    isEPT() {
        return this.isEPTResource;
    }

    /**
     * Generate a query for this loader given the specified parameters.
     * @param params
     * @return {object} An object which encodes all needed settings to successfully query a remote resource.  This
     * object should be
     */
    queryFor(params) {
        const renderSpaceBounds = util.checkParam(params, 'renderSpaceBounds');
        const geoTransform = util.checkParam(params, 'geoTransform');

        const depthBegin = util.checkParam(params, 'depthBegin');
        const depthEnd = util.checkParam(params, 'depthEnd');

        const treePath = util.checkParam(params, 'treePath');
        const eptKey = util.checkParam(params, 'eptKey');

        let schema = GreyhoundPipelineLoader._buildSchema(this.sourceSchema, this.brushes);
        let brushes = BrushFactory.serializeBrushes(this.brushes);

        let result = {
            server: this.server,
            resource: this.resource,
            depthBegin: depthBegin,
            depthEnd: depthEnd,
            renderSpaceBounds: renderSpaceBounds,
            schema: schema,
            sourceSchema: this.sourceSchema,
            brushes: brushes,
            fullGeoBounds: geoTransform.fullGeoBounds,
            scale: geoTransform.scale,
            offset: geoTransform.offset,
            treePath: treePath,
            eptKey: eptKey,
            eptDataStorage: this.eptDataStorage,
            key: this.key,
            creds: (this.allowGreyhoundCreds === true),
            eptRootUrl: this.eptRootUrl,
        };

        if (this.filter)
            result.filter = this.filter;

        return result;
    }


    /**
     * Asynchronously load hierarchy information for the given render space bounds.
     * @param renderSpaceBounds {Number[]} A 6-element array specifying the render space bounds for the region to query.
     * @param geoTransform {GeoTransform} The geo transform object for currently loaded resource.
     * @param depthBegin {Number} The start depth for query.
     * @param depthEnd {Number} The end depth for query.
     * @return Returns the hierarchy information.
     */
    async loadHierarchyInfo(renderSpaceBounds, geoTransform, depthBegin, depthEnd) {
        if (this.isEPT())
            throw new Error('You may not request hierarchy for EPT resources, use loadEPTHierarchyInfo.');

        const treeSpaceBounds = geoTransform.transform(renderSpaceBounds, 'render', 'tree');

        let qs =
            "bounds=" + encodeURIComponent(JSON.stringify(treeSpaceBounds)) + "&" +
            "depthBegin=" + depthBegin + "&" +
            "depthEnd=" + depthEnd + "&" +
            "scale=" + encodeURIComponent(JSON.stringify(geoTransform.scale)) + "&" +
            "offset=" + encodeURIComponent(JSON.stringify(geoTransform.offset));

        if (this.filter) {
            qs = qs + "&filter=" + encodeURIComponent(JSON.stringify(this.filter));
        }


        var u = util.joinPath(util.pickOne(this.server), "resource", this.resource, "hierarchy") + "?" + qs;
        return await util.getJson(u, { creds: this.allowGreyhoundCreds });
    }

    /**
     * Asynchronously load EPT hierarchy info, we don't need special arguments here since EPT hierarchy is flat.
     * @param nodeName {String} The name of the node to fetch, if null, then base entwine-hierarchy is fetched.
     * @returns {Promise<Object>} Key-value map of all EPT node Ids and their respective point counts.
     */
    async loadEPTHierarchyInfo(nodeName) {
        if (!this.isEPT())
            throw new Error('You may not request EPT hierarchy for non-EPT resources.');

        const url = (nodeName == null) ? util.joinPath(this.eptRootUrl, 'ept-hierarchy', '0-0-0-0.json')
            : util.joinPath(this.eptRootUrl, 'ept-hierarchy', `${nodeName}.json`);
        return await util.getJson(url, { creds: this.allowGreyhoundCreds });
    }

    /**
     * Sets the brush spec for a specific color channel at the given index. Up to 4 color channels can be set at index 0-3 inclusive.
     * @param index {Number} The index to set the color source as
     * @param source {string} The color source specification e.g. <tt>local://color</tt>.
     */
    setColorChannelBrush(index, source) {
        if (index >= 4)
            throw new Error('Index needs to be less than 4 when setting color channel');

        this.brushes[index] = (source == null) ? null : BrushFactory.createBrush(source);
    }

    /**
     * Set the filter specification to the given parameter
     * @param filter {object} Filter specification as a javascript object.`
     */
    setFilter(filter) {
        this.filter = filter;
    }

    static async _colorizeBufferWithTasks(buffer, schema, totalPoints, sizeInBytes, colorizers) {
        if (totalPoints === 0)
            return b;

        let inputPointSizeInFloats = sizeInBytes / 4; // the point as it came from the source, normalized to floats
        let totalColorChannels = _.size(colorizers);
        let outputPointSizeInFloats = 3 + totalColorChannels; // 3 is for X, Y and Z and one float per color channel

        // allocate destination array, has all need color channels
        let coloredBuffer = new Float32Array(totalPoints * outputPointSizeInFloats);
        let decomposePoint = this._createPointDecomposer(schema);

        var taskFn = function (start, end) {
            return new Promise((resolve) => {
                let offr = inputPointSizeInFloats * start;
                let offw = outputPointSizeInFloats * start;

                for (let i = start; i < end; i++) {
                    // get the current point as a float array
                    let p = decomposePoint(buffer, offr);

                    // position
                    coloredBuffer[offw] = p.x;
                    coloredBuffer[offw + 1] = p.y;
                    coloredBuffer[offw + 2] = p.z;

                    // all color channels
                    for (let ci = 0 ; ci < totalColorChannels ; ci ++) {
                        let colorizer = colorizers[ci];
                        let col = colorizer == null ? black : colorizer.colorPoint(p);

                        coloredBuffer[offw + 3 + ci] = util.compressColor(col);
                    }

                    offw += outputPointSizeInFloats;
                    offr += inputPointSizeInFloats;
                }

                resolve();
            });
        };

        // when we don't have a ton of points to color, just color them in one go and return the results
        const BATCH_SIZE = 10000;

        if (totalPoints < BATCH_SIZE) {
            taskFn(0, totalPoints);
            return coloredBuffer;
        }

        let allTasks = [];
        for (let i = 0 ; i < totalPoints ; i += BATCH_SIZE) {
            const start = i;
            const end = Math.min(i + BATCH_SIZE, totalPoints);

            allTasks.push(taskFn(start, end));
        }

        await Promise.all(allTasks);
        return coloredBuffer;
    }

    static async _colorizeBuffer(schema, buffer, totalPoints, sizeInBytes, renderSpaceBounds, colorizers, params, stats) {
        // prep all colorizers which may include fetching imagery
        await Promise.all(colorizers.map(c => c.prep({
            currentParams: params, stats: stats, renderSpaceBounds: renderSpaceBounds
        })));

        // if we have no colorizers, just return the input buffer as it is
        //
        if (colorizers.length === 0)
            return buffer;

        return await this._colorizeBufferWithTasks(buffer, schema, totalPoints, sizeInBytes, colorizers);
    }

    static _imageryToAvailableColors(brushes) {
        const r = [];
        let count = brushes.filter(brush => brush != null).length;
        for (let i = 0 ; i < 4 ; i ++) {
            r.push((i < count) ? 1 : 0);
        }
        return r;
    };


    static async _internalLoad(params, loadParams) {
        const server = util.checkParam(params, 'server', null);
        const resource = util.checkParam(params, 'resource', null);
        const eptRootUrl = util.checkParam(params, 'eptRootUrl', null);

        // either the server and resource need to be available or ept root url
        // needs to be un-available
        if (eptRootUrl == null && (server == null || resource == null)) {
            throw new Error('Load failed, either the EPT root URL needs to be provided or the server and resource keys should be valid');
        }

        const key = util.checkParam(params, 'key');

        const schema = util.checkParam(params, 'schema');
        const sourceSchema = util.checkParam(params, 'sourceSchema');
        const depthBegin = util.checkParam(params, 'depthBegin');
        const depthEnd = util.checkParam(params, 'depthEnd');

        const renderSpaceBounds = util.checkParam(params, 'renderSpaceBounds');

        const fullGeoBounds = util.checkParam(params, 'fullGeoBounds');
        const scale = util.checkParam(params, 'scale');
        const offset = util.checkParam(params, 'offset');

        const brushes = util.checkParam(params, 'brushes');
        const treePath = util.checkParam(params, 'treePath');

        const eptKey = util.checkParam(params, 'eptKey', null);
        const eptDataStorage = util.checkParam(params, 'eptDataStorage', null);

        const geoTransform = new GeoTransform(fullGeoBounds, scale, offset);
        const treeSpaceBounds = geoTransform.transform(renderSpaceBounds, 'render', 'tree');

        const [fullPointCloudRangeX] = geoTransform.coordinateSpaceRange('geo');


        const weight = util.checkParam(loadParams, 'weight');

        // compute the incoming point size? Even though we may request the points in unsigned,
        // they are all delivered after conversion into floats
        //
        const incomingPointSize = 4 * schema.length;

        const query =  {
            server: server,
            resource: resource,
            bounds: treeSpaceBounds,
            depthBegin: depthBegin,
            depthEnd: depthEnd,
            fullGeoBounds: fullGeoBounds,
            scale: scale,
            offset: offset,
            allowCreds: params.creds,
            schema: schema,
            sourceSchema: sourceSchema,
            weight: weight,
            eptRootUrl: eptRootUrl,
            eptKey: eptKey,
            eptDataStorage: eptDataStorage
        };

        if (params.filter) {
            query.filter = params.filter;
        }

        // decompress data, buffer.response is inaccessible beyond this point
        const decompressedData = await loader.push(query);

        const decompressedBuffer = decompressedData.buffer;
        const totalIncomingPoints = decompressedData.numPoints;
        const decompressedStats = decompressedData.stats;

        if (totalIncomingPoints === 0) {
            return {
                totalPoints: 0
            };
        }

        pointCloudBufferStats = util.accumulateStats(pointCloudBufferStats, decompressedStats);

        // build up attributes for this buffer
        let attribs = [["position", 0, 3]];
        let attribOffset = 3;

        // color processing
        let neededColorChannels = brushes.filter(b => b != null).length;

        // Push a color attribute for each needed color channel, only one float per channel
        // because we do some fancy color compression into a single float
        //
        for(let i = 0 ; i < neededColorChannels ; i ++) {
            attribs.push(["color" + i, attribOffset, 1]);
            attribOffset = attribOffset + 1;
        }

        // get all colorizers we need
        const brushObjects = BrushFactory.deserializeBrushes(brushes);
        const downloadedBufferParams = {
            key: key,
            data: decompressedBuffer,
            totalPoints: totalIncomingPoints,
            renderSpaceBounds: renderSpaceBounds,
            bufferStats: decompressedStats,
            pointCloudBufferStats: pointCloudBufferStats,
            treePath: treePath,
            schema: schema,
            geoTransform: geoTransform
        };

        const buf = await PointBufferCache.getInstance().push(downloadedBufferParams, brushObjects);

        // prepare uniforms
        const cleanupBrushes = brushObjects.filter(b => b != null);
        const channelClampPicks = [];
        const channelRampContribution = [0, 0, 0, 0];
        const channelColorRamps = [];

        cleanupBrushes.forEach((b, i) => {
            // each brush needs to tell us what particular value does its color
            // clamping requires.
            const {selector, start, end} = b.rampConfiguration();
            if (selector !== ClampSelector.NONE) {
                // Color ramps are needed.
                const pickArray = [0, 0, 0, 0];
                pickArray[selector - 1] = 1.0;

                channelClampPicks.push(["channelClampsPick" + i, pickArray]);

                channelColorRamps.push(["channelColorRamp" + i + "Start", start || [0, 0, 0]]);
                channelColorRamps.push(["channelColorRamp" + i + "End", end || [1, 1, 1]]);

                // Mark this particular channel as required ramp contribution
                channelRampContribution[i] = 1;
            }
        });

        const result = {
            key: key,
            pointStride: (3 + neededColorChannels) * 4,
            displayImportance: treePath.length,   // the deeper the node in tree, the more important it is that we display it
            totalPoints: totalIncomingPoints,
            attributes: attribs,
            uniforms: [["availableColors", GreyhoundPipelineLoader._imageryToAvailableColors(brushes)]]
                .concat(channelClampPicks)
                .concat(channelColorRamps)
                .concat([["channelRampContribution", channelRampContribution]]),
            data: buf,
            stats: decompressedStats
        };

        return result;
    }

    /**
     * Load resource for given params which were initially generated through queryFor method.
     * @param params {object} The parameters as generated by the queryFor method, this object should be treated as an
     * opaque object.
     * @param loadParams {object} Additional load time parameters.
     * @param loadParams.weight {Number} Weight of the resource being loaded, higher weight means they are queued first for downloading.
     * @param cb The callback called when the load completes.
     * @return {Promise.<T>} A promise which resolves to the loaded buffer.
     */
    static load(params, loadParams, cb) {
        return GreyhoundPipelineLoader._internalLoad(params, loadParams).then((res) => {
            if(cb) cb(null, res);
            return res;
        }).catch((err) => {
            console.log('buffer load failed with params:', params, loadParams, err);
            if(cb) cb(err);
            else throw err;
        })
    };
}
