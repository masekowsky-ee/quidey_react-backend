// Which version of the native apps is current, and which is too old to keep working. The apps ask
// GET /api/app-version?platform=android&version=<build number> when they start and when they come
// back to the front; the answer decides whether they offer an update or insist on one.
//
// Set per platform in .env (nothing set = no update is ever announced):
//   ANDROID_LATEST_VERSION_CODE / ANDROID_LATEST_VERSION_NAME   the newest build in the store
//   ANDROID_MIN_VERSION_CODE                                    older builds must update
//   ANDROID_STORE_URL                                           default: the Play listing
//   IOS_LATEST_VERSION_CODE / IOS_LATEST_VERSION_NAME / IOS_MIN_VERSION_CODE / IOS_STORE_URL
const PLATFORMS = ["android", "ios"];
const DEFAULT_STORE = { android: "https://play.google.com/store/apps/details?id=com.quidey.app", ios: null };

const whole = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
};

function versionInfo(platform, current, env = process.env) {
    if (!PLATFORMS.includes(platform)) return null;
    const prefix = platform.toUpperCase();
    const latestCode = whole(env[`${prefix}_LATEST_VERSION_CODE`]);
    const minCode = whole(env[`${prefix}_MIN_VERSION_CODE`]);
    const version = whole(current);
    return {
        platform,
        latest: latestCode === null ? null : { code: latestCode, name: env[`${prefix}_LATEST_VERSION_NAME`] || null },
        minSupported: minCode,
        // without a known build number nothing is announced: the app can't be told it is behind
        updateAvailable: version !== null && latestCode !== null && version < latestCode,
        mustUpdate: version !== null && minCode !== null && version < minCode,
        storeUrl: env[`${prefix}_STORE_URL`] || DEFAULT_STORE[platform],
    };
}

module.exports = { versionInfo, PLATFORMS };
