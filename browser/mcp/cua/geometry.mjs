// Quads (top-left, top-right, bottom-right, bottom-left corners, as CDP reports boxes) and the
// projective mapping between the unit square and a quad, which also covers perspective transforms.

// The mapping of the unit square onto a quad, fixed by its four corners.
export function squareToQuad([x0, y0, x1, y1, x2, y2, x3, y3]) {
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;
  let g = 0;
  let h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const [dx1, dx2, dy1, dy2] = [x1 - x2, x3 - x2, y1 - y2, y3 - y2];
    const det = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
  }
  const [a, b, c] = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0];
  const [d, e, f] = [y1 - y0 + g * y1, y3 - y0 + h * y3, y0];
  return Object.assign(
    (u, v) => {
      const w = g * u + h * v + 1;
      return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
    },
    { matrix: [a, b, c, d, e, f, g, h, 1] },
  );
}

// The inverse: a point of the quad to unit-square coordinates.
export function quadToSquare(quad) {
  const [a, b, c, d, e, f, g, h, i] = squareToQuad(quad).matrix;
  // Adjugate of the 3x3 matrix; the common factor cancels in the division.
  const m = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
  return (x, y) => {
    const w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  };
}
