import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toPoints, fromPoints, average } = require('../../utils/grades');

test('marks become points by 17 - 3 * mark, out of range is null', () => {
    assert.equal(toPoints(1, 'marks'), 14);
    assert.equal(toPoints(2, 'marks'), 11);
    assert.equal(toPoints(6, 'marks'), 0);
    assert.equal(toPoints(1.5, 'marks'), 12.5);
    assert.equal(toPoints(7, 'marks'), null);
    assert.equal(toPoints(0.9, 'marks'), null);
    assert.equal(toPoints(16, 'points'), null);
    assert.equal(toPoints(-1, 'points'), null);
    assert.equal(toPoints(12, 'points'), 12);
    assert.equal(toPoints('12', 'points'), null);
    assert.equal(toPoints(NaN, 'points'), null);
});

test('points are shown back as marks (to 0.1) or points', () => {
    assert.equal(fromPoints(11, 'marks'), 2);
    assert.equal(fromPoints(12.5, 'marks'), 1.5);
    assert.equal(fromPoints(14, 'points'), 14);
    assert.equal(fromPoints(0, 'marks'), 5.7);
});

test('the average is a plain mean, null without grades', () => {
    assert.equal(average([]), null);
    assert.equal(average([10, 12]), 11);
    assert.equal(average([10, 11]), 10.5);
});
