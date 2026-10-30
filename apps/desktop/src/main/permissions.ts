/** What the page may be granted, and to whom. Kept free of Electron so tests can drive it. */
export interface PermissionSession<C extends Contents = Contents> {
  setPermissionRequestHandler(
    handler: (
      wc: C,
      permission: string,
      callback: (granted: boolean) => void,
      details: Details,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (wc: C | null, permission: string, origin: string, details: Details) => boolean,
  ): void;
}
export interface Contents {
  getURL(): string;
}
interface Details {
  requestingUrl?: string;
  isMainFrame: boolean;
}

/**
 * Grants `allowed` to the app's own page and to nothing else. `fromApp` says
 * whether the contents, address and frame are the app's. Chromium leaves the
 * requesting address empty for some checks (device enumeration): the
 * contents' own address stands in, for the top frame only.
 */
export function grantToApp<C extends Contents>(
  session: PermissionSession<C>,
  allowed: readonly string[],
  fromApp: (wc: C | null, url: string | undefined, top: boolean) => boolean,
) {
  const may = (wc: C | null, permission: string, details: Details) =>
    allowed.includes(permission) &&
    fromApp(
      wc,
      details.requestingUrl || (details.isMainFrame ? wc?.getURL() : undefined),
      details.isMainFrame,
    );
  session.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(may(wc, permission, details)),
  );
  session.setPermissionCheckHandler((wc, permission, _origin, details) =>
    may(wc, permission, details),
  );
}
