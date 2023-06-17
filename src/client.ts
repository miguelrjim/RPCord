import { EventEmitter } from "events";
import { DiscordIPC } from "./ipc";
import { Packet } from "./packet";
import {
  Application,
  ChannelPayload,
  ClientConfig,
  Command,
  Device,
  GetImageOptions,
  Guild,
  OpCode,
  PartialChannel,
  PartialGuild,
  Relationship,
  RPCEvent,
  ShortcutKeyCombo,
  User,
  UserVoiceSettings,
  VoiceSettings,
} from "./types";
import fetch from "node-fetch";
import { Presence } from "./presence";
import { v4 } from "uuid";
import { LobbyManager } from "./managers/lobby";
import { AchievementManager } from "./managers/achievement";
import { OverlayManager } from "./managers/overlay";
import { NetworkingManager } from "./managers/networking";

export const IGNORED_AUTO_EVENTS: string[] = [
  "OVERLAY",
  "OVERLAY_UPDATE",
  "READY",
  "ERROR",
  "MESSAGE_CREATE",
  "MESSAGE_DELETE",
  "MESSAGE_UPDATE",
  "NOTIFICATION_CREATE",
  "CAPTURE_SHORTCUT_CHANGE",
  "VOICE_CONNECTION_STATUS",
  "VOICE_SETTINGS_UPDATE",
  "VOICE_STATE_DELETE",
  "VOICE_STATE_UPDATE",
  "VOICE_STATE_CREATE",
  "VOICE_CHANNEL_SELECT",
  "CHANNEL_CREATE",
  "GUILD_CREATE",
  "GUILD_STATUS",
];

/** Client options to initialize. */
export interface RPClientOptions {
  secret?: string;
  scopes?: string[];
}

/** High-level wrapper over Discord IPC. */
export class RPClient extends EventEmitter {
  /** Client ID */
  id: string;
  /** Discord RPC Version */
  v: number = 1;
  /** Internal IPC */
  ipc: DiscordIPC;
  /** Whether Client is Authorized yet or not */
  authorized: boolean = false;
  /** Whether Client is Authenticated yet or not */
  authenticated: boolean = false;
  /** Auth Code saved from `authorize` */
  authCode?: string;
  /** Access Token saved from `authenticate` */
  accessToken?: string;
  /** Scopes to use for Authorization */
  scopes?: string[];
  /** Client Secret (for fetching Access Token from Auth Code) */
  secret?: string;
  /** Underlying User account of the Discord Client */
  user?: User;
  /** RPC Client Config (Discord) */
  config?: ClientConfig;
  /** User's cached Voice Settings */
  userVoiceSettings?: UserVoiceSettings;
  /** Expiration of Access Token */
  expires?: number;
  /** Application object of the Client */
  application?: Application;
  /** Whether Client is connected or not */
  connected: boolean = false;

  lobbyManager: LobbyManager;
  achievementManager: AchievementManager;
  overlayManager: OverlayManager;
  networkingManager: NetworkingManager;
  private _subscribed: string[] = [];

  constructor(id: string, options?: RPClientOptions) {
    super();
    this.id = id;
    if (options) {
      this.secret = options.secret;
      this.scopes = options.scopes;
    }

    this.ipc = new DiscordIPC();
    this.ipc.on("connect", () => (this.connected = true));
    this.ipc.on("close", () => (this.connected = false));
    this.ipc.on("packet", (packet: Packet) => this.processPacket(packet));

    this.lobbyManager = new LobbyManager(this);
    this.achievementManager = new AchievementManager(this);
    this.overlayManager = new OverlayManager(this);
    this.networkingManager = new NetworkingManager(this);
    this.setMaxListeners(100);
  }

  private processPacket(packet: Packet) {
    if (packet.op == OpCode.Close) {
      this.emit("error", new Error(
        `Discord IPC Closed (${packet.data.code}): ${packet.data.message}`
      ));
    }

    switch (packet.op) {
      case OpCode.Frame:
        const cmd = packet.data.cmd as Command;
        const data = packet.data.data;
        const nonce = packet.data.nonce;

        if (packet.data.evt && packet.data.evt == "ERROR") {
          this.emit("error", data, nonce);
        } else {
          const evt = cmd
            .split("_")
            .map(
              (e, i) =>
                `${i == 0 ? e[0].toLowerCase() : e[0].toUpperCase()}${e
                  .slice(1)
                  .toLowerCase()}`
            )
            .join("");

          switch (cmd) {
            case Command.Dispatch:
              this.emit("dispatch", packet.data, nonce);
              this.processEvent(packet.data.evt, data);
              break;

            case Command.Authorize:
              this.authorized = true;
              this.authCode = data.code;
              this.emit("authorize", data.code, nonce);
              this.fetchAccessToken();
              break;

            case Command.Authenticate:
              this.authenticated = true;
              this.user = data.user;
              this.scopes = data.scopes;
              this.expires = data.expires;
              this.application = data.application;
              this.emit("authenticate", data, nonce);
              break;

            default:
              this.emit(evt, data, nonce);
              break;
          }
        }
        break;

      case OpCode.Ping:
        this.ipc.send(new Packet(OpCode.Pong, packet.data));
        break;

      default:
        break;
    }
  }

  private async processEvent(evt: RPCEvent, data: any) {
    this.emit("raw", evt, data);

    switch (evt) {
      case RPCEvent.Ready:
        this.user = data.user;
        this.config = data.config;
        for (const e of Object.values(RPCEvent)) {
          if (IGNORED_AUTO_EVENTS.includes(e)) continue;
          try {
            await this.subscribe(e);
          } catch (e) {}
        }
        this.emit("ready");
        break;

      case RPCEvent.CurrentUserUpdate:
        this.user = data;
        this.emit("currentUserUpdate", data);
        break;

      default:
        const event = evt
          .split("_")
          .map((e, i) =>
            i == 0
              ? e.toLowerCase()
              : `${e[0].toUpperCase()}${e.slice(1).toLowerCase()}`
          )
          .join("");

        this.emit(event, data);
        break;
    }
  }

  /** Subscribe for an RPC Event. */
  async subscribe(evt: RPCEvent, args?: any) {
    if (this._subscribed.includes(evt) && typeof args !== "object") return this;
    const nonce = v4();

    const wait = this.waitFor("subscribe", (_, n) => n == nonce, 10000).then(
      () => {
        if (typeof args !== "object" && !this._subscribed.includes(evt))
          this._subscribed.push(evt);
        return this;
      }
    );

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.Subscribe,
        args: args ?? {},
        evt,
        nonce,
      })
    );

    return wait;
  }

  /** Unsubscribe from an RPC Event. */
  async unsubscribe(evt: RPCEvent, args?: any) {
    const nonce = v4();

    const wait = this.waitFor("unsubscribe", (_, n) => n == nonce, 10000).then(
      () => {
        if (typeof args !== "object" && this._subscribed.includes(evt))
          this._subscribed = this._subscribed.filter((e) => e !== evt);
        return this;
      }
    );

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.Unsubscribe,
        args: args ?? {},
        evt,
        nonce,
      })
    );

    return wait;
  }

  /** Connect to Discord IPC. */
  async connect() {
    await this.ipc.connect();

    const wait = this.waitFor("ready").then(() => this);

    this.ipc.send(
      new Packet(OpCode.Handshake, {
        v: 1,
        client_id: this.id,
      })
    );

    return wait;
  }

  /** Authorize for given scopes (or scopes in Client Options). */
  async authorize(scopes?: string[]) {
    if (this.authorized || this.authenticated)
      throw new Error("Already authorized");

    if (scopes) this.scopes = scopes;
    if (!this.scopes) this.scopes = ["rpc"];

    if (!this.scopes.includes("rpc")) this.scopes.push("rpc");

    const wait = this.waitFor("authenticate").then(() => this);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.Authorize,
        args: {
          client_id: this.id,
          scopes: this.scopes.join(" "),
          grant_type: "authorization_code",
        },
      })
    );

    return wait;
  }

  /** Authenticate using an existing Access Token */
  async authenticate(token?: string) {
    if (this.authenticated) throw new Error("Already Authenticated");

    if (token) this.accessToken = token;
    if (!this.accessToken) throw new Error("Access Token is required");

    const wait = this.waitFor("authenticate").then(() => this);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.Authenticate,
        args: {
          access_token: this.accessToken,
        },
      })
    );

    return wait;
  }

  /** Fetches Access Token from given Auth Code */
  private async fetchAccessToken(code?: string) {
    if (code) this.authCode = code;
    if (this.accessToken) throw new Error("Access Token already fetched");
    if (!this.authCode) throw new Error("No Auth Code given");

    const form = new URLSearchParams();
    form.set("client_id", this.id);
    form.set("client_secret", this.secret ?? "");
    form.set("scopes", this.scopes?.join(" ") ?? "");
    form.set("grant_type", "authorization_code");
    form.set("code", this.authCode);

    const res = await fetch("https://discord.com/api/v8/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }).then((r) => r.json());

    this.accessToken = res.access_token;
    this.authenticate();
    return this.accessToken;
  }

  /** Set User's Activity (Presence) */
  async setActivity(activity: Presence): Promise<Presence> {
    const nonce = v4();

    const wait = this.waitFor("setActivity", (_, n) => n == nonce, 10000).then(
      (act) => new Presence(act[0])
    );

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.SetActivity,
        args: {
          pid: process.pid,
          activity,
        },
        nonce,
      })
    );

    return wait;
  }

  /** Get a Guild by ID */
  async getGuild(id: string, timeout: number = 5000): Promise<Guild> {
    const nonce = v4();

    const wait = this.waitFor("getGuild", (_, n) => n === nonce, timeout).then(
      (guild) => guild[0]
    );

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetGuild,
        args: {
          guild_id: id,
          timeout: Math.floor(timeout / (1000 * 60)),
        },
        nonce,
      })
    );

    return wait;
  }

  /** Get all Guilds of the User */
  async getGuilds(timeout: number = 5000): Promise<PartialGuild[]> {
    const nonce = v4();

    const wait = this.waitFor("getGuilds", (_, n) => n === nonce, timeout).then(
      (d) => d[0].guilds
    );

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetGuilds,
        args: {},
        nonce,
      })
    );

    return wait;
  }

  /** Get a Channel by ID */
  async getChannel(
    id: string,
    timeout: number = 5000
  ): Promise<ChannelPayload> {
    const nonce = v4();

    const wait = this.waitFor(
      "getChannel",
      (_, n) => n === nonce,
      timeout
    ).then((guild) => guild[0]);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetChannel,
        args: {
          channel_id: id,
        },
        nonce,
      })
    );

    return wait;
  }

  /** Get all Channels or channels of a specific Guild */
  async getChannels(
    guild?: string,
    timeout: number = 5000
  ): Promise<PartialChannel[]> {
    const nonce = v4();

    const wait = this.waitFor(
      "getChannels",
      (_, n) => n === nonce,
      timeout
    ).then((d) => d[0].channels);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetChannels,
        args: {
          guild_id: guild,
        },
        nonce,
      })
    );

    return wait;
  }

  /** Set User's Voice Settings (only one property at a time or Discord will error) */
  async setUserVoiceSettings(
    settings: UserVoiceSettings,
    timeout = 5000
  ): Promise<UserVoiceSettings> {
    const nonce = v4();

    const wait = this.waitFor(
      "setUserVoiceSettings",
      (_, n) => n === nonce,
      timeout
    ).then((data) => data[0]);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.SetUserVoiceSettings,
        args: settings,
        nonce,
      })
    );

    return wait;
  }

  /** Select a Voice Channel by ID */
  async selectVoiceChannel(
    id: string,
    force?: boolean,
    timeout = 5000
  ): Promise<ChannelPayload> {
    const nonce = v4();

    const wait = this.waitFor(
      "selectVoiceChannel",
      (_, n) => n === nonce,
      timeout
    ).then((chan) => chan[0]);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.SelectVoiceChannel,
        args: {
          channel_id: id,
          force,
          timeout: Math.floor(timeout / (1000 * 60)),
        },
        nonce,
      })
    );

    return wait;
  }

  /** Select a Text Channel by ID */
  async selectTextChannel(id: string, timeout = 5000): Promise<ChannelPayload> {
    const nonce = v4();

    const wait = this.waitFor(
      "selectTextChannel",
      (_, n) => n === nonce,
      timeout
    ).then((chan) => chan[0]);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.SelectTextChannel,
        args: {
          channel_id: id,
          timeout: Math.floor(timeout / (1000 * 60)),
        },
        nonce,
      })
    );

    return wait;
  }

  /** Get selected Voice Channel */
  async getSelectedVoiceChannel(timeout = 5000): Promise<ChannelPayload> {
    const nonce = v4();

    const wait = this.waitFor(
      "getSelectedVoiceChannel",
      (_, n) => n === nonce,
      timeout
    ).then((data) => data[0]);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetSelectedVoiceChannel,
        args: {},
        nonce,
      })
    );

    return wait;
  }

  /** Get Voice Settins of Client */
  async getVoiceSettings(timeout = 5000): Promise<VoiceSettings> {
    const nonce = v4();

    const wait = this.waitFor(
      "getVoiceSettings",
      (_, n) => n === nonce,
      timeout
    ).then((data) => data[0]);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetVoiceSettings,
        args: {},
        nonce,
      })
    );

    return wait;
  }

  /** Set Voice Settings of Client. Only one property to update at once supported */
  async setVoiceSettings(
    settings: VoiceSettings,
    timeout = 5000
  ): Promise<VoiceSettings> {
    const nonce = v4();

    const wait = this.waitFor(
      "setVoiceSettings",
      (_, n) => n === nonce,
      timeout
    ).then((data) => data[0]);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.SetVoiceSettings,
        args: settings,
        nonce,
      })
    );

    return wait;
  }

  /** START or STOP capturing shortcut */
  async captureShortcut(
    action: "START" | "STOP",
    timeout = 5000
  ): Promise<ShortcutKeyCombo[]> {
    if (action != "START" && action != "STOP")
      throw new Error("Invalid Action. Must be either START or STOP");
    const nonce = v4();

    const wait = this.waitFor(
      "captureShortcut",
      (_, n) => n === nonce,
      timeout
    ).then((data) => data[0].shortcut);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.CaptureShortcut,
        args: {
          action,
        },
        nonce,
      })
    );

    return wait;
  }

  /** Start capturing shortcut */
  async startCaptureShortcut(timeout = 5000): Promise<ShortcutKeyCombo[]> {
    return this.captureShortcut("START", timeout);
  }

  /** Stop capturing shortcut */
  async stopCaptureShortcut(timeout = 5000): Promise<ShortcutKeyCombo[]> {
    return this.captureShortcut("STOP", timeout);
  }

  /** Set Certified Devices (Audio/Video) */
  async setCertifiedDevices(
    devices: Device[],
    timeout = 5000
  ): Promise<RPClient> {
    const nonce = v4();

    const wait = this.waitFor(
      "setCertifiedDevices",
      (_, n) => n === nonce,
      timeout
    ).then(() => this);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.SetCertifiedDevices,
        args: {
          devices,
        },
        nonce,
      })
    );

    return wait;
  }

  /** Approve an Activity Join Request (by user ID) */
  sendActivityJoinInvite(id: string) {
    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.SendActivityJoinInvite,
        args: {
          user_id: id,
        },
      })
    );
  }

  /** Close (decline) an Activity Join Request */
  closeActivityRequest(id: string) {
    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.CloseActivityRequest,
        args: {
          user_id: id,
        },
      })
    );
  }

  /** Get array of Relationships (Presences) */
  async getRelationships(timeout = 5000): Promise<Relationship[]> {
    const nonce = v4();

    const wait = this.waitFor(
      "getRelationships",
      (_, n) => n == nonce,
      timeout
    ).then((d) => d[0].relationships);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetRelationships,
        nonce,
      })
    );

    return wait;
  }

  /** Returns an Array of SKUs */
  async getSkus(timeout: number = 5000): Promise<any[]> {
    const nonce = v4();

    const wait = this.waitFor("getSkus", (_, n) => n === nonce, timeout).then(
      (d) => d[0]
    );

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetSkus,
        nonce,
      })
    );

    return wait;
  }

  /** Returns an Array of Entitlements */
  async getEntitlements(timeout: number = 5000): Promise<any[]> {
    const nonce = v4();

    const wait = this.waitFor(
      "getEntitlements",
      (_, n) => n === nonce,
      timeout
    ).then((d) => d[0]);

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetEntitlements,
        nonce,
      })
    );

    return wait;
  }

  /** Gets an Image's Data (base64 URI). Supports only type: "user" ATM which is User Avatar */
  async getImage(options: GetImageOptions, timeout = 5000): Promise<string> {
    const nonce = v4();

    const wait = this.waitFor("getImage", (_, n) => n == nonce, timeout).then(
      (d) => d[0]
    );

    this.ipc.send(
      new Packet(OpCode.Frame, {
        cmd: Command.GetImage,
        args: options,
        nonce,
      })
    );

    return wait;
  }

  /** Wait for an event to fire */
  async waitFor(
    event: string,
    checkFunction: (...args: any[]) => boolean = () => true,
    timeout?: number
  ): Promise<any[]> {
    return await new Promise((resolve, reject) => {
      let timeoutID: any | undefined;
      if (timeout !== undefined) {
        timeoutID = setTimeout(() => {
          this.off(event, eventFunc);
          this.off("error", errorFunc);
          reject(new Error("Timed out: " + event));
        }, timeout);
      }
      const eventFunc = (...args: any[]): void => {
        if (checkFunction(...args)) {
          this.off(event, eventFunc);
          this.off("error", errorFunc);
          if (timeoutID !== undefined) clearTimeout(timeoutID);
          resolve(args);
        }
      };
      const errorFunc = (...args: any[]): void => {
        if (checkFunction(...args)) {
          this.off(event, eventFunc);
          this.off("error", errorFunc);
          if (timeoutID !== undefined) clearTimeout(timeoutID);
          reject(args[0]);
        }
      };
      this.on("error", errorFunc);
      this.on(event, eventFunc);
    });
  }

  /** Disconnect from Discord IPC */
  disconnect(): void {
    this.ipc.close();
    this.connected = false;
  }
}
