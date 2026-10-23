// Polyline helpers for keeping buses on their route shapes. Everything is in the map scene's flat
// metres (x east, y north), so distances and angles are plain Euclidean maths.

// Small backward moves (GPS jitter) still count as "here", not as going backwards.
const BACKTRACK_SLACK_M = 30;
// Cost of a match behind the bus's last known position: buses don't reverse along their route.
const BACKWARD_PENALTY_M = 60;
// Cost of a match running the opposite way to a known heading, for first sightings.
const HEADING_PENALTY_M = 30;
// Headings are measured over this much road either side of a point, so corners turn smoothly.
const HEADING_SPAN_M = 6;

export class ShapeLine {
  constructor(points) {
    const n = points.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.cum = new Float64Array(n); // distance from the start to each vertex
    for (let i = 0; i < n; i++) {
      this.xs[i] = points[i][0];
      this.ys[i] = points[i][1];
      if (i > 0) this.cum[i] = this.cum[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]);
    }
    this.length = n ? this.cum[n - 1] : 0;
  }

  // Closest point on the line to (px, py), as { along, offset } in metres.
  // `near` (metres along) prefers matches at or ahead of the bus's last position, which matters where a
  // shape passes the same street twice (loops, out-and-back ends). Without it, `heading` (radians,
  // counter-clockwise from east) prefers segments running the same way.
  project(px, py, { near = null, heading = null } = {}) {
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < this.xs.length - 1; i++) {
      const ax = this.xs[i];
      const ay = this.ys[i];
      const dx = this.xs[i + 1] - ax;
      const dy = this.ys[i + 1] - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const offset = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (offset >= bestScore) continue; // penalties only add, so this segment can't win
      const along = this.cum[i] + t * Math.sqrt(len2);
      let score = offset;
      if (near != null) {
        const ahead = along - near;
        score += ahead >= -BACKTRACK_SLACK_M ? 0.01 * Math.max(0, ahead) : BACKWARD_PENALTY_M + 0.05 * -ahead;
      } else if (heading != null) {
        score += (HEADING_PENALTY_M * (1 - Math.cos(Math.atan2(dy, dx) - heading))) / 2;
      }
      if (score < bestScore) {
        bestScore = score;
        best = { along, offset };
      }
    }
    return best ?? { along: 0, offset: Infinity };
  }

  // The point `along` metres from the start, clamped to the line's ends.
  pointAt(along) {
    const last = this.xs.length - 1;
    if (last <= 0) return [this.xs[0] ?? 0, this.ys[0] ?? 0];
    const d = Math.max(0, Math.min(this.length, along));
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segment = this.cum[hi] - this.cum[lo];
    const t = segment > 0 ? (d - this.cum[lo]) / segment : 0;
    return [this.xs[lo] + t * (this.xs[hi] - this.xs[lo]), this.ys[lo] + t * (this.ys[hi] - this.ys[lo])];
  }

  // Direction of travel at `along`, in radians counter-clockwise from east.
  headingAt(along) {
    const [x1, y1] = this.pointAt(along - HEADING_SPAN_M);
    const [x2, y2] = this.pointAt(along + HEADING_SPAN_M);
    return Math.atan2(y2 - y1, x2 - x1);
  }
}
