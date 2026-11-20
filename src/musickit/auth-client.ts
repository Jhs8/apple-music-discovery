import { MusicKitAuthError, readSdkError, scrubMessage } from "./errors.ts";

export { MusicKitAuthError } from "./errors.ts";

export interface DeveloperTokenProvider {
  getDeveloperToken(): string | Promise<string>;
}

export interface MusicKitAuthSession {
  configure(input: {
    developerToken: string;
    app: { name: string; build?: string };
  }): Promise<unknown>;
  authorize(): Promise<string | undefined>;
  unauthorize(): Promise<unknown>;
  isAuthorized(): boolean;
}

export type AuthStatus = "unconfigured" | "configured" | "authorized" | "unauthorized";

export interface AuthorizeResult {
  status: "authorized";
}

export interface UnauthorizeResult {
  status: "unauthorized";
}

export interface MusicKitAuthClientOptions {
  appName: string;
  appBuild?: string;
  tokenProvider: DeveloperTokenProvider;
  session: MusicKitAuthSession;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function requiredText(value: string, code: string, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MusicKitAuthError("error", code, message);
  }
  return value.trim();
}

const DENIED_MESSAGE = "MusicKit authorization was not granted.";
const SUPERSEDED_MESSAGE = "Authorization superseded by unauthorize.";

export class MusicKitAuthClient {
  #appName: string;
  #appBuild: string | undefined;
  #tokenProvider: DeveloperTokenProvider;
  #session: MusicKitAuthSession;
  #status: AuthStatus = "unconfigured";
  #developerToken: string | undefined;
  #latched = false;
  #configureAttempt: Promise<void> | null = null;
  #publicConfigure: Promise<void> | null = null;
  #configurePending = false;
  #authorizeFlight: Promise<AuthorizeResult> | null = null;
  #unauthorizeFlight: Promise<UnauthorizeResult> | null = null;
  #supersede = false;
  #supersedeWait: Deferred<UnauthorizeResult> | null = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: MusicKitAuthClientOptions) {
    this.#appName = requiredText(options.appName, "MISSING_APP_NAME", "App name is empty.");
    if (options.appBuild !== undefined) {
      this.#appBuild = requiredText(options.appBuild, "MISSING_APP_BUILD", "App build is empty.");
    }
    this.#tokenProvider = options.tokenProvider;
    this.#session = options.session;
  }

  getStatus(): AuthStatus {
    return this.#status;
  }

  getPending(): "configure" | "authorize" | "unauthorize" | null {
    if (this.#authorizeFlight) {
      return "authorize";
    }
    if (this.#unauthorizeFlight) {
      return "unauthorize";
    }
    if (this.#configurePending) {
      return "configure";
    }
    return null;
  }

  configure(): Promise<void> {
    if (this.#latched) {
      return Promise.resolve();
    }
    if (this.#publicConfigure) {
      return this.#publicConfigure;
    }
    this.#configurePending = true;
    let published!: Promise<void>;
    published = this.#enqueue(() => this.#beginConfigure()).then(
      () => {
        this.#configurePending = false;
      },
      (error: unknown) => {
        this.#configurePending = false;
        if (this.#publicConfigure === published) {
          this.#publicConfigure = null;
        }
        throw error;
      },
    );
    this.#publicConfigure = published;
    return published;
  }

  authorize(): Promise<AuthorizeResult> {
    if (this.#authorizeFlight) {
      return this.#authorizeFlight;
    }
    this.#supersede = false;
    const flight = this.#enqueue(() => this.#runAuthorize());
    this.#authorizeFlight = flight;
    void flight.then(
      () => {
        if (this.#authorizeFlight === flight) {
          this.#authorizeFlight = null;
        }
      },
      () => {
        if (this.#authorizeFlight === flight) {
          this.#authorizeFlight = null;
        }
      },
    );
    return flight;
  }

  unauthorize(): Promise<UnauthorizeResult> {
    if (this.#authorizeFlight) {
      this.#supersede = true;
      if (!this.#supersedeWait) {
        this.#supersedeWait = deferred();
      }
      return this.#supersedeWait.promise;
    }
    if (this.#unauthorizeFlight) {
      return this.#unauthorizeFlight;
    }
    const flight = this.#enqueue(() => this.#runUnauthorize());
    this.#unauthorizeFlight = flight;
    void flight.then(
      () => {
        if (this.#unauthorizeFlight === flight) {
          this.#unauthorizeFlight = null;
        }
      },
      () => {
        if (this.#unauthorizeFlight === flight) {
          this.#unauthorizeFlight = null;
        }
      },
    );
    return flight;
  }

  async #runAuthorize(): Promise<AuthorizeResult> {
    try {
      await this.#beginConfigure();
    } catch (error) {
      const mapped = this.#asAuthError(error);
      if (this.#supersede) {
        this.#status = "unauthorized";
        this.#settleSupersede({ status: "unauthorized" });
      } else if (mapped.kind === "denied") {
        this.#status = "unauthorized";
      }
      throw mapped;
    }
    if (this.#supersede) {
      await this.#finishSupersede();
    }
    let returned: unknown;
    try {
      returned = await this.#session.authorize();
    } catch (error) {
      if (this.#supersede) {
        await this.#finishSupersede();
      }
      const mapped = this.#asAuthError(error);
      if (mapped.kind === "denied") {
        this.#status = "unauthorized";
      }
      throw mapped;
    }
    if (this.#supersede) {
      await this.#finishSupersede();
    }
    if (typeof returned !== "string" || returned.length === 0) {
      try {
        await this.#session.unauthorize();
      } catch {
        // The empty result is already a denial. A follow-up revoke failure stays that denial.
      }
      this.#status = "unauthorized";
      throw new MusicKitAuthError("denied", "AUTHORIZATION_ERROR", DENIED_MESSAGE);
    }
    this.#status = "authorized";
    return { status: "authorized" };
  }

  async #runUnauthorize(): Promise<UnauthorizeResult> {
    if (!this.#latched) {
      this.#status = "unauthorized";
      return { status: "unauthorized" };
    }
    try {
      await this.#session.unauthorize();
    } catch (error) {
      this.#status = this.#readAuthorized() ? "authorized" : "unauthorized";
      throw this.#asAuthError(error);
    }
    this.#status = "unauthorized";
    return { status: "unauthorized" };
  }

  async #finishSupersede(): Promise<never> {
    try {
      await this.#session.unauthorize();
      this.#status = "unauthorized";
      this.#settleSupersede({ status: "unauthorized" });
    } catch (error) {
      this.#status = this.#readAuthorized() ? "authorized" : "unauthorized";
      this.#rejectSupersede(this.#asAuthError(error));
    }
    throw new MusicKitAuthError("denied", "AUTHORIZATION_ERROR", SUPERSEDED_MESSAGE);
  }

  async #beginConfigure(): Promise<void> {
    if (this.#latched) {
      return;
    }
    if (!this.#configureAttempt) {
      this.#configureAttempt = this.#performConfigure()
        .then(() => {
          this.#latched = true;
        })
        .catch((error: unknown) => {
          this.#configureAttempt = null;
          throw error;
        });
    }
    await this.#configureAttempt;
  }

  async #performConfigure(): Promise<void> {
    let raw: string;
    try {
      raw = await this.#tokenProvider.getDeveloperToken();
    } catch (cause) {
      throw new MusicKitAuthError(
        "error",
        "DEVELOPER_TOKEN_PROVIDER_FAILED",
        "Developer token provider failed.",
        { cause },
      );
    }
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new MusicKitAuthError("error", "MISSING_DEVELOPER_TOKEN", "Developer token is empty.");
    }
    const developerToken = raw.trim();
    const app: { name: string; build?: string } = { name: this.#appName };
    if (this.#appBuild !== undefined) {
      app.build = this.#appBuild;
    }
    try {
      await this.#session.configure({ developerToken, app });
    } catch (error) {
      throw this.#asAuthError(error, [developerToken]);
    }
    let restored = false;
    try {
      restored = this.#session.isAuthorized();
    } catch (error) {
      throw this.#asAuthError(error, [developerToken]);
    }
    this.#developerToken = developerToken;
    if (restored) {
      this.#status = "authorized";
    } else if (this.#status === "unconfigured") {
      this.#status = "configured";
    }
  }

  #readAuthorized(): boolean {
    try {
      return this.#session.isAuthorized();
    } catch {
      return false;
    }
  }

  #settleSupersede(result: UnauthorizeResult): void {
    const wait = this.#supersedeWait;
    this.#supersedeWait = null;
    this.#supersede = false;
    wait?.resolve(result);
  }

  #rejectSupersede(error: MusicKitAuthError): void {
    const wait = this.#supersedeWait;
    this.#supersedeWait = null;
    this.#supersede = false;
    wait?.reject(error);
  }

  #asAuthError(error: unknown, extraSecrets: readonly string[] = []): MusicKitAuthError {
    if (error instanceof MusicKitAuthError) {
      return error;
    }
    const secrets = [this.#developerToken, ...extraSecrets].filter(
      (secret): secret is string => typeof secret === "string" && secret.length > 0,
    );
    const sdk = readSdkError(error);
    if (!sdk) {
      return new MusicKitAuthError("error", "UNKNOWN_ERROR", "MusicKit authorization failed.", {
        cause: error,
      });
    }
    if (sdk.code === "AUTHORIZATION_ERROR") {
      return new MusicKitAuthError("denied", "AUTHORIZATION_ERROR", DENIED_MESSAGE, { cause: error });
    }
    return new MusicKitAuthError("error", sdk.code, scrubMessage(sdk.message, sdk.code, secrets), {
      cause: error,
    });
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
