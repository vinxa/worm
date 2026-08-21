export const GAME_TIMEZONE = '+08:00';
export const COMPACT_LAYOUT_QUERY =
    "(max-width: 1200px), (orientation: landscape) and (max-height: 600px)";
export const SHORT_LANDSCAPE_QUERY =
    "(orientation: landscape) and (max-height: 600px)";
export const TABLET_LAYOUT_QUERY =
    "(min-width: 700px) and (min-height: 700px) and (max-width: 1400px)";
export const DESKTOP_TIMELINE_QUERY =
    "(min-width: 1201px) and (min-height: 601px)";
export const KEYBOARD_SHORTCUT_HINTS_QUERY =
    `${TABLET_LAYOUT_QUERY}, ${DESKTOP_TIMELINE_QUERY}`;
export const COARSE_POINTER_QUERY = "(any-pointer: coarse)";
export const LIVE_PRESENTATION_DELAY_SECONDS = 5;
export const S3_BASE_URL = 'https://worm-game-data.s3.ap-southeast-2.amazonaws.com';
export const WS_URL = "wss://1km1prnds5.execute-api.ap-southeast-2.amazonaws.com/production";
