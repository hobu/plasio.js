/**
 * Created by verma on 12/30/16.
 */


import { BaseBrush, TransferDirection } from './brush';
import { parseBrushSpec } from './util';

import {
    LocalColor, LocalRamp, LocalFieldColor,
    RemoteImagery
} from './stock-brushes';


// stock brushes
let availableBrushes = {
    'local://color': LocalColor,
    'local://ramp': LocalRamp,
    'local://field-color': LocalFieldColor,
    'remote://imagery': RemoteImagery
};

/**
 * Creates brushes based on a URL spec, allows for registration and de-registration of brush types.  The library provides
 * several stock brushes which may be queried using {@link BrushFactory.availableBrushes} function.
 *
 * Custom brushes derived from the {@linkcode BaseBrush} class may be registered which then become available for use.  The
 * {@linkcode BrushFactory.registerBrush} may be used to do so.
 *
 *
 * ```javascript
 * class MapboxBrush extends BaseBrush {
 *     // ...
 * }
 *
 * // Makes the brush available as tms://mapbox?...
 * BrushFactory.registerBrush('tms', 'mapbox', MapboxBrush);
 * ```
 */
export class BrushFactory {
    /**
     * Creates a brush given a brush spec in URL form.
     * @param {String} spec The brush specification, e.g. <tt>local://color</tt>.
     */
    static createBrush(spec) {
        const {
            scheme, name, params
        } = parseBrushSpec(spec);

        const key = scheme + "://" + name;
        const klass = availableBrushes[key];

        if (!klass)
            throw new Error('Unrecognized brush spec: ' + key);

        return new klass(spec, scheme, name, params);
    }

    /**
     * Serialize given brushes to a JSON array.
     *
     * @param {BaseBrush[]} brushes An array of brushes to serialize. This array may contain null values, which are just
     * propagated through.
     * @return {Object[]} An array of serialized brushes.
     */
    static serializeBrushes(brushes) {
        return brushes.map(b => {
            if (!b)
                return null;

            return {
                s: b.brushSpec,
                p: b.serialize()
            }
        });
    }

    /**
     * Deserialize given brushes from JSON and return instantiated {@link BaseBrush} instances.
     *
     * @param {Object[]} objects An array of serialized brush objects. This array may contain null values, which are just
     * propagated through.
     * @return {BaseBrush[]} An array of brush instances.
     */
    static deserializeBrushes(objects) {
        return objects.map(o => {
            if (!o)
                return null;

            if (!o.s)
                throw new Error('Invalid object to deserialize, a brushes being deserialized must be serialized with the serializer function.');

            const b = BrushFactory.createBrush(o.s);
            b.deserialize(o.p);
            return b;
        });
    }


    /**
     * Register a brush with the given scheme, name and implementation class. If a brush with the given
     * `scheme` and `name` are already registered, they are overridden by the provided implementation class `klass`.  This way
     * you can override stock brushes.
     *
     * @param {String} scheme The scheme name, e.g. <tt>local</tt>.
     * @param {String} name The unique name for the brush, e.g. <tt>color</tt>.
     * @param {Object} klass A class derived from the {@link BaseBrush} class.
     */
    static registerBrush(scheme, name, klass) {
        const key = scheme + "://" + name;
        availableBrushes[key] = klass;
    }


    /**
     * De-register an already registered brush.  No-op if there's no brush to de-register.
     * @param {String} scheme The scheme name of brush to de-register.
     * @param {String} name The unique name of the brush to de-register.
     */
    static deregisterBrush(scheme, name) {
        const key = scheme + "://" + name;
        delete availableBrushes[key];
    }

    /**
     * Get a list of available brushes.
     *
     * @return {String[]} An array of brushes available, e.g. <tt>["local://color"]</tt>.
     */
    static availableBrushes() {
        return Object.keys(availableBrushes);
    }

    /**
     * Create a transfer structure for all brushes in the input array
     *
     * @param {TransferDirection} direction The direction of transfer
     * @param {Array.<BaseBrush>} brushes Brushes to create transfer structure out of, null positions will
     * be replaced with null values (important to preserve order).
     *
     * @return {Array.<Object>} An array of brush specs along with any transfer lists
     */
    static beginTransferForBrushes(direction, brushes) {
        let transferList = [];
        let transferObject = [];
        for (let i = 0, il = brushes.length ; i < il ; i ++) {
            const b = brushes[i];
            if (b) {
                const p = b.beginTransfer(direction);
                transferObject.push({
                    brushSpec: b.brushSpec,
                    params: p.params
                });
                transferList = transferList.concat(p.transferList || []);
            }
        }

        return {
            params: transferObject,
            transferList: transferList
        };
    }

    /**
     * Take a transfer list and emit a vector of brushes, created from the given transfer structure
     *
     * @param {TransferDirection} direction The direction of transfer
     * @param {Array.<Object>} transferParams Transfer structure which was created using the beginTransferForBrushes function
     *
     * @return {Array.<BaseBrush>} An array of prepped brushes ready for painting
     */
    static endTransferForBrushes(direction, transferParams) {
        return transferParams.map(t => {
            if (!t) return null;

            const brush = BrushFactory.createBrush(t.brushSpec);
            brush.endTransfer(direction, t.params);

            return brush;
        })
    }

    /**
     * Takes a transfer list and ends transfer onto an existing brushes array, the transfer list and brushes array should match.
     *
     * @param {TransferDirection} direction The direction of transfer
     * @param {Array.<BaseBrush>} ontpBrushes The brushes to transfer onto.
     * @param {Array.<Object>} transferParams Transfer structure which was created using the beginTransferForBrushes function
     *
     * @return {Array.<BaseBrush>} An array of prepped brushes ready for painting
     */
    static endTransferOntoBrushes(direction, ontoBrushes, transferParams) {
        return transferParams.map((t, i) => {
            if (!t) return null;

            ontoBrushes[i].endTransfer(direction, t.params);
            return ontoBrushes[i];
        })
    }
}
