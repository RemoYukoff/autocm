// Everything autocm assumes about X's web app, in one place.
//
// UNVERIFIED AGAINST LIVE X. These were written from X's long-standing web markup (data-testid attributes) and
// GraphQL API, without a logged-in session. In October 2026 a logged-out load of x.com showed a reworked web
// client ("x-web": relay-style *.graphql bundles, api.x.com/1.1/graphql/viewer_context.json), so the classic
// operation names below may no longer appear in URLs. That is why responses are matched by JSON *shape*
// (src/x/graphql.ts) and the operation names are only hints. Selectors avoid visible text and aria-labels:
// the browser runs in the system locale (es-419), so any translated string would break.
//
// When X changes and something stops working, fix it here first; failures save a screenshot under
// out/x-debug/<slug>/ (never the HTML: it can contain tokens).

/** Default origin. Tests point the client at a local fixture server instead. */
export const X_ORIGIN = "https://x.com";

export const PATHS = {
  login: "/login",
  home: "/home",
  compose: "/compose/post",
  profile: (handle: string) => `/${handle}`,
} as const;

/** Where X sends a browser that is logged out, locked or challenged (pathname prefixes). */
export const AUTH_WALL_PATHS = ["/login", "/i/flow/login", "/i/flow/signup", "/account/access", "/account/suspended", "/i/flow/consent_flow"];

/** Session cookie set by X after a successful login. Only its presence is checked; its value is never read or logged. */
export const AUTH_COOKIE = "auth_token";

export const SEL = {
  /** The compose modal /compose/post opens over the home timeline (which has its own inline composer behind it). */
  composeModal: '[aria-modal="true"], [role="dialog"]',
  /** Composer text area (Draft.js contenteditable). `_0` is the first post of a thread. */
  composerText: '[data-testid="tweetTextarea_0"]',
  /** Hidden <input type=file> of the composer toolbar. */
  fileInput: 'input[data-testid="fileInput"]',
  /** "Post" button inside the compose modal (the inline home composer uses tweetButtonInline). */
  postButton: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
  /** Attached media thumbnails in the composer. */
  attachment: '[data-testid="attachments"] [role="group"], [data-testid="attachments"] img, [data-testid="attachments"] video',
  /** Upload/processing progress shown on an attachment. */
  uploadProgress: '[data-testid="attachments"] [role="progressbar"]',
  /** Opens the media editor where the description (alt text) is entered. */
  altTextOpen: '[data-testid="altTextEditButton"], a[href="/compose/post/media"], a[href$="/media/edit"]',
  altTextInput: '[data-testid="altTextInput"], textarea[name="altTextInput"]',
  altTextSave: '[data-testid="endEditingButton"], [data-testid="altTextSaveButton"]',
  /** Toast/alert X shows on errors ("Something went wrong", "You already said that", ...). Text is translated: log only. */
  toast: '[data-testid="toast"], [role="alert"]',
  /** Present only when logged in. */
  loggedInMarker: '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]',
  /** Link to the logged-in account's profile; its href is "/<handle>". */
  profileLink: '[data-testid="AppTabBar_Profile_Link"]',
  /** Present on the logged-out landing / login wall. */
  loggedOutMarker: '[data-testid="loginButton"], [data-testid="LoginForm_Login_Button"], a[href="/login"][role="link"]',
  /** Profile page header (DOM fallback for the display name). */
  profileName: '[data-testid="UserName"]',
  /** Avatar image (DOM fallback); src is on pbs.twimg.com/profile_images/. */
  avatarImg: 'img[src*="/profile_images/"]',
} as const;

/**
 * GraphQL operation names as they appear in the URL (/i/api/graphql/<queryId>/<OperationName>). Hints only:
 * matching is by response shape, these just get checked first and are logged.
 */
export const GQL_OPS = {
  createTweet: ["CreateTweet", "CreateNoteTweet"],
  tweetDetail: ["TweetDetail", "TweetResultByRestId"],
  user: ["UserByScreenName", "Viewer", "ViewerAccountSync"],
} as const;

/** Any GraphQL response from X's own web client (classic /i/api/graphql/ or the newer api.x.com/.../graphql/). */
export const GRAPHQL_URL = /\/graphql\//;

/**
 * X API error codes that can come back inside a CreateTweet response ({errors:[{code,message}]}).
 * Public, long-stable codes; whether the new client still returns them is unverified.
 */
export const X_ERROR_CODES = {
  auth: [32, 64, 89, 135, 215, 220, 326, 239],
  duplicate: [187],
  automated: [226],
  rateLimit: [88, 185, 344],
} as const;

/** Bounded waits (ms). Video upload + processing on X can take minutes. Mutable only so tests can shorten them. */
export const WAIT = {
  navigation: 45_000,
  composer: 30_000,
  imageUpload: 90_000,
  videoUpload: 10 * 60_000,
  createTweet: 60_000,
  profile: 30_000,
  login: 10 * 60_000,
};
