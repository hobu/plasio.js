var PointPicker = require("./point-picker").PointPicker,
    LosFeature = require("../features/line-of-sight").LineOfSight;

var LineOfSightPicker = function(elem, renderer) {
    PointPicker.call(this, elem, renderer);
    this.height = 2;
    this.radius = 250;
    this.losFeature = new LosFeature(renderer);
}

LineOfSightPicker.prototype = new PointPicker();

LineOfSightPicker.prototype.constructor = LineOfSightPicker;

LineOfSightPicker.prototype._add = function(p, id) {
    this.resetState();

    id = 'los-' + id;
    p[1] += this.height;

    this.points.push(id);
    this.renderer.addLineSegment(id, p, p, [255, 255, 255]);

    this.losFeature.go(p, this.radius);
};

LineOfSightPicker.prototype.resetState = function() {
    for (var i = 0; i < this.points.length; ++i) {
        this.renderer.removeLineSegment(this.points[i]);
    }

    this.points = [];
    this.losFeature.resetState();
}

LineOfSightPicker.prototype.setHeight = function(h) { this.height = h; }
LineOfSightPicker.prototype.setRadius = function(r) { this.radius = r; }

module.exports = {
    LineOfSightPicker: LineOfSightPicker
};

