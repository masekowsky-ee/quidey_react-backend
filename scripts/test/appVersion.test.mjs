// utils/appVersion.js: when an app is told to update, and when it must. No database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { versionInfo } = createRequire(import.meta.url)("../../utils/appVersion");

const env = { ANDROID_LATEST_VERSION_CODE: "12", ANDROID_LATEST_VERSION_NAME: "1.2.0", ANDROID_MIN_VERSION_CODE: "8" };

test("an old build is offered the update, a current one is not", () => {
    assert.equal(versionInfo("android", "10", env).updateAvailable, true);
    assert.equal(versionInfo("android", "12", env).updateAvailable, false);
    assert.equal(versionInfo("android", "13", env).updateAvailable, false);
});

test("a build below the minimum must update", () => {
    assert.equal(versionInfo("android", "7", env).mustUpdate, true);
    assert.equal(versionInfo("android", "8", env).mustUpdate, false);
});

test("without settings nothing is announced", () => {
    const info = versionInfo("android", "1", {});
    assert.equal(info.updateAvailable, false);
    assert.equal(info.mustUpdate, false);
    assert.equal(info.latest, null);
});

test("an unknown build number never forces anything", () => {
    const info = versionInfo("android", undefined, env);
    assert.equal(info.updateAvailable, false);
    assert.equal(info.mustUpdate, false);
});

test("reports the newest build and the store address", () => {
    const info = versionInfo("android", "1", { ...env, ANDROID_STORE_URL: "https://example.com/get" });
    assert.deepEqual(info.latest, { code: 12, name: "1.2.0" });
    assert.equal(info.storeUrl, "https://example.com/get");
    assert.equal(versionInfo("ios", "1", {}).storeUrl, null);
});

test("knows only android and ios", () => {
    assert.equal(versionInfo("windows", "1", env), null);
});
