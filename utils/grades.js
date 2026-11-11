// Grades of finished work (Lernen as school life). Stored as points 0-15; marks 1-6 (1 best) are
// converted by the German rule: points = 17 - 3 * mark (clamped to 0-15), mark = (17 - points) / 3.

const SCALES = ['points', 'marks'];
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// A value typed in the account's scale -> points, null when it isn't a number in range
function toPoints(value, scale) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (scale === 'marks') {
        if (value < 1 || value > 6) return null;
        return round2(Math.min(15, Math.max(0, 17 - 3 * value)));
    }
    if (value < 0 || value > 15) return null;
    return round2(value);
}

// Points -> the account's scale (marks to 0.1)
function fromPoints(points, scale) {
    return scale === 'marks' ? round1((17 - points) / 3) : round2(points);
}

// A plain mean of points, null without grades
function average(points) {
    const grades = points.filter((p) => typeof p === 'number' && Number.isFinite(p));
    return grades.length === 0 ? null : grades.reduce((sum, p) => sum + p, 0) / grades.length;
}

module.exports = { SCALES, toPoints, fromPoints, average };
