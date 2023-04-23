import {
	APIMessage,
	ChannelType,
	GatewayChannelCreateDispatchData,
	GatewayChannelDeleteDispatchData,
	GatewayCloseCodes,
	GatewayDispatchEvents,
	GatewayDispatchPayload,
	GatewayGuild,
	GatewayGuildCreateDispatchData,
	GatewayGuildDeleteDispatchData,
	GatewayGuildMemberListUpdateDispatchData,
	GatewayGuildModifyDispatchData,
	GatewayHeartbeat,
	GatewayHelloData,
	GatewayIdentify,
	GatewayLazyRequest,
	GatewayLazyRequestData,
	GatewayMessageCreateDispatchData,
	GatewayMessageDeleteDispatchData,
	GatewayMessageUpdateDispatchData,
	GatewayOpcodes,
	GatewayPresenceUpdateDispatchData,
	GatewayReadyDispatchData,
	GatewayReceivePayload,
	GatewaySendPayload,
	PresenceUpdateStatus,
	Snowflake,
} from "@spacebarchat/spacebar-api-types/v9";
import { action, makeObservable, observable, runInAction } from "mobx";
import AppStore from "./AppStore";

const GATEWAY_VERSION = "9";
const GATEWAY_ENCODING = "json";

export default class GatewayConnectionStore {
	@observable private socket: WebSocket | null = null;
	@observable private sessionId: string | null = null;
	@observable public readyState: number = WebSocket.CLOSED;

	private app: AppStore;
	private url?: string;
	private heartbeatInterval: number | null = null;
	private heartbeater: NodeJS.Timeout | null = null;
	private initialHeartbeatTimeout: NodeJS.Timeout | null = null;
	// eslint-disable-next-line @typescript-eslint/ban-types
	private dispatchHandlers: Map<GatewayDispatchEvents, Function> = new Map();
	private connectionStartTime?: number;
	private identifyStartTime?: number;
	private sequence: number = 0;
	private heartbeatAck: boolean = true;
	private lazyRequestChannels = new Map<string, Snowflake[]>(); // guild, channels

	constructor(app: AppStore) {
		this.app = app;

		makeObservable(this);
	}
	/**
	 * Starts connection to gateway
	 */
	@action
	async connect(url: string) {
		const newUrl = new URL(url);
		newUrl.searchParams.append("v", GATEWAY_VERSION);
		newUrl.searchParams.append("encoding", GATEWAY_ENCODING);
		this.url = newUrl.href;
		console.debug(`[Connect] ${this.url}`);
		this.connectionStartTime = Date.now();
		this.socket = new WebSocket(this.url);
		this.readyState = WebSocket.CONNECTING;

		this.setupListeners();
		this.setupDispatchHandler();
	}

	@action
	async disconnect(code?: number, reason?: string) {
		if (!this.socket) {
			return;
		}

		this.readyState = WebSocket.CLOSING;
		console.debug(`[Disconnect] ${this.url}`);
		this.socket?.close(code, reason);
	}

	private setupListeners() {
		this.socket!.onopen = this.onopen;
		this.socket!.onmessage = this.onmessage;
		this.socket!.onerror = this.onerror;
		this.socket!.onclose = this.onclose;
	}

	private setupDispatchHandler() {
		this.dispatchHandlers.set(GatewayDispatchEvents.Ready, this.onReady);
		this.dispatchHandlers.set(
			GatewayDispatchEvents.Resumed,
			this.onResumed,
		);
		this.dispatchHandlers.set(
			GatewayDispatchEvents.GuildCreate,
			this.onGuildCreate,
		);
		this.dispatchHandlers.set(
			GatewayDispatchEvents.GuildUpdate,
			this.onGuildUpdate,
		);
		this.dispatchHandlers.set(
			GatewayDispatchEvents.GuildDelete,
			this.onGuildDelete,
		);
		this.dispatchHandlers.set(
			GatewayDispatchEvents.GuildMemberListUpdate,
			this.onGuildMemberListUpdate,
		);

		this.dispatchHandlers.set(
			GatewayDispatchEvents.ChannelCreate,
			this.onChannelCreate,
		);
		this.dispatchHandlers.set(
			GatewayDispatchEvents.ChannelDelete,
			this.onChannelDelete,
		);

		this.dispatchHandlers.set(
			GatewayDispatchEvents.MessageCreate,
			this.onMessageCreate,
		);
		this.dispatchHandlers.set(
			GatewayDispatchEvents.MessageUpdate,
			this.onMessageUpdate,
		);
		this.dispatchHandlers.set(
			GatewayDispatchEvents.MessageDelete,
			this.onMessageDelete,
		);

		this.dispatchHandlers.set(
			GatewayDispatchEvents.PresenceUpdate,
			this.onPresenceUpdate,
		);
	}

	private onopen = () => {
		console.debug(
			`[Connected] ${this.url} (took ${
				Date.now() - this.connectionStartTime!
			}ms)`,
		);
		this.readyState = WebSocket.OPEN;

		this.handleIdentify();
	};

	private onmessage = (e: MessageEvent<any>) => {
		const payload: GatewayReceivePayload = JSON.parse(e.data);
		if (payload.op !== GatewayOpcodes.Dispatch) {
			console.debug(`[Gateway] -> ${payload.op}`, payload);
		}

		switch (payload.op) {
			case GatewayOpcodes.Dispatch:
				this.handleDispatch(payload);
				break;
			case GatewayOpcodes.Heartbeat:
				this.sendHeartbeat();
				break;
			case GatewayOpcodes.Reconnect:
				this.handleReconnect();
				break;
			case GatewayOpcodes.InvalidSession:
				this.handleInvalidSession(payload.d);
				break;
			case GatewayOpcodes.Hello:
				this.handleHello(payload.d);
				break;
			case GatewayOpcodes.HeartbeatAck:
				this.handleHeartbeatAck();
				break;
			default:
				console.debug("Received unknown opcode");
				break;
		}
	};

	private onerror = (e: Event) => {
		console.error("[Gateway] Socket Error", e);
	};

	private onclose = (e: CloseEvent) => {
		this.readyState = WebSocket.CLOSED;
		this.handleClose(e.code);
	};

	private sendJson = (payload: GatewaySendPayload) => {
		if (!this.socket) {
			console.error("Socket is not open");
			return;
		}

		if (this.socket.readyState !== WebSocket.OPEN) {
			console.error(
				`Socket is not open; readyState: ${this.socket.readyState}`,
			);
			return;
		}
		console.debug(`[Gateway] <- ${payload.op}`, payload);
		this.socket.send(JSON.stringify(payload));
	};

	/**
	 * Sends Identify payload to gateway
	 */
	private handleIdentify = () => {
		console.debug("handleIdentify called");
		if (!this.app.token) {
			return console.error("Token shouldn't be null here");
		}
		this.identifyStartTime = Date.now();

		const payload: GatewayIdentify = {
			op: GatewayOpcodes.Identify,
			d: {
				token: this.app.token!,
				properties: {
					browser: "Spacebar Web",
					client_build_number: 0,
					release_channel: "dev",
					browser_user_agent: navigator.userAgent,
				},
				compress: false,
				presence: {
					status: PresenceUpdateStatus.Online,
					since: Date.now(),
					activities: [],
					afk: false,
				},
			},
		};
		this.sendJson(payload);
	};

	/**
	 * Processes an invalid session opcode
	 */
	private handleInvalidSession = (resumable: boolean) => {
		this.cleanup();

		console.debug(`Received invalid session; Can Resume: ${resumable}`);
		if (!resumable) {
			return;
		}

		// TODO: handle resumable
	};

	/**
	 * Processes a reconnect opcode
	 */
	private handleReconnect() {
		this.cleanup();
		console.debug("Received reconnect");
	}

	private handleResume() {
		console.debug("handleResume called");
		if (!this.app.token) {
			return console.error("Token shouldn't be null here");
		}

		this.sendJson({
			op: GatewayOpcodes.Resume,
			d: {
				token: this.app.token!,
				session_id: this.sessionId!,
				seq: this.sequence,
			},
		});
	}

	private handleHello = (data: GatewayHelloData) => {
		this.heartbeatInterval = data.heartbeat_interval;
		console.info(
			`[Hello] heartbeat interval: ${data.heartbeat_interval} (took ${
				Date.now() - this.connectionStartTime!
			}ms)`,
		);
		this.startHeartbeater();
	};

	canReconnect(code: GatewayCloseCodes | undefined) {
		if (!code) {
			return true;
		}

		switch (code) {
			case GatewayCloseCodes.AuthenticationFailed:
			case GatewayCloseCodes.InvalidShard:
			case GatewayCloseCodes.ShardingRequired:
			case GatewayCloseCodes.InvalidAPIVersion:
			case GatewayCloseCodes.InvalidIntents:
			case GatewayCloseCodes.DisallowedIntents:
				return false;
			default:
				return true;
		}
	}

	private handleClose = (code: number | undefined) => {
		this.cleanup();

		if (code === 4004) {
			console.warn("closed because of authentication failure.");
			// remove token, this will send us back to the login screen
			// TODO: maybe we could show a toast here so the user knows why they got logged out
			this.app.logout();
			this.reset();
			this.app.setAppLoading(false);
			return;
		}

		// TODO: handle reconnect/resume
	};

	/**
	 * Resets the gateway state
	 */
	private reset = () => {
		this.sessionId = null;
		this.sequence = 0;
		this.readyState = WebSocket.CLOSED;
	};

	/**
	 * Starts the heartbeat interval
	 */
	private startHeartbeater = () => {
		if (this.heartbeater) {
			clearInterval(this.heartbeater);
			this.heartbeater = null;
		}

		const heartbeaterFn = () => {
			if (this.heartbeatAck) {
				this.heartbeatAck = false;
				this.sendHeartbeat();
			} else {
				this.handleHeartbeatTimeout();
			}
		};

		this.initialHeartbeatTimeout = setTimeout(() => {
			this.initialHeartbeatTimeout = null;
			this.heartbeater = setInterval(
				heartbeaterFn,
				this.heartbeatInterval!,
			);
			heartbeaterFn();
		}, Math.floor(Math.random() * this.heartbeatInterval!));
	};

	/**
	 * Stops the heartbeat interval
	 */
	private stopHeartbeater = () => {
		if (this.heartbeater) {
			clearInterval(this.heartbeater);
			this.heartbeater = null;
		}

		if (this.initialHeartbeatTimeout) {
			clearTimeout(this.initialHeartbeatTimeout);
			this.initialHeartbeatTimeout = null;
		}
	};

	/**
	 * Handles a heartbeat timeout
	 */
	private handleHeartbeatTimeout = () => {
		console.warn(
			`[Heartbeat ACK Timeout] should reconnect in ${(
				this.heartbeatInterval! / 1000
			).toFixed(2)} seconds`,
		);

		this.socket?.close(4009);

		// TODO: reconnect
		this.cleanup();
		this.reset();
	};

	/**
	 * Sends a heartbeat
	 */
	private sendHeartbeat = () => {
		const payload: GatewayHeartbeat = {
			op: GatewayOpcodes.Heartbeat,
			d: this.sequence,
		};
		console.debug("Sending heartbeat");
		this.sendJson(payload);
	};

	/**
	 * Stops heartbeat interval and removes socket
	 */
	private cleanup = () => {
		console.debug("Cleaning up");
		this.stopHeartbeater();
		this.socket = null;
	};

	/**
	 * Processes a heartbeat ack opcode
	 */
	private handleHeartbeatAck = () => {
		console.debug("Received heartbeat ack");
		this.heartbeatAck = true;
	};

	/**
	 * processes a dispatch opcode
	 */
	private handleDispatch = (data: GatewayDispatchPayload) => {
		const { d, t, s } = data;
		console.debug(`[Gateway] -> ${t}`, d);
		this.sequence = s;
		const handler = this.dispatchHandlers.get(t);
		if (!handler) {
			console.debug(`No handler for dispatch event ${t}`);
			return;
		}

		handler(d);
	};

	/**
	 * Processes a resumed dispatch event
	 */
	private onResumed = () => {
		console.debug("Resumed");
	};

	/**
	 * Processes a ready dispatch event
	 */
	private onReady = (data: GatewayReadyDispatchData) => {
		console.info(
			`[Ready] took ${Date.now() - this.connectionStartTime!}ms`,
		);
		const { session_id, guilds, users, user, private_channels } = data;
		this.sessionId = session_id;

		this.app.setUser(user);

		// TODO: store guilds
		this.app.guilds.addAll(guilds);
		this.app.guilds.setInitialGuildsLoaded();
		// TODO: store users
		if (users) {
			this.app.users.addAll(users);
		}
		// TODO: store relationships
		// TODO: store readstates
		this.app.privateChannels.addAll(private_channels);

		this.app.setGatewayReady(true);
	};

	public onChannelOpen = (guildId: Snowflake, channelId: Snowflake) => {
		let payload: GatewayLazyRequestData;

		const guildChannels = this.lazyRequestChannels.get(guildId);

		if (!guildChannels) {
			payload = {
				guild_id: guildId,
				activities: true,
				threads: true,
				typing: true,
				channels: {
					[channelId]: [[0, 99]],
				},
			};
			this.lazyRequestChannels.set(guildId, [channelId]);

			this.sendJson({
				op: GatewayOpcodes.LazyRequest,
				d: payload,
			} as GatewayLazyRequest);
		} else {
			if (guildChannels.includes(channelId)) {
				return;
			}

			const d: Record<string, [number, number][]> = {};
			guildChannels.forEach((x) => (d[x] = [[0, 99]]));
			payload = {
				guild_id: guildId,
				channels: d,
			};
			guildChannels.push(channelId);

			this.sendJson({
				op: GatewayOpcodes.LazyRequest,
				d: payload,
			} as GatewayLazyRequest);
		}
	};

	// Start dispatch handlers

	private onGuildCreate = (data: GatewayGuildCreateDispatchData) => {
		console.debug("Received guild create event");
		runInAction(() => {
			this.app.guilds.add({
				...data,
				...data.properties,
			} as unknown as GatewayGuild);
		});
	};

	private onGuildUpdate = (data: GatewayGuildModifyDispatchData) => {
		console.debug("Received guild update event");
		this.app.guilds.get(data.id)?.update(data);
	};

	private onGuildDelete = (data: GatewayGuildDeleteDispatchData) => {
		console.debug("Received guild delete event");
		runInAction(() => {
			this.app.guilds.remove(data.id);
		});
	};

	private onGuildMemberListUpdate = (
		data: GatewayGuildMemberListUpdateDispatchData,
	) => {
		console.debug("Received GuildMemberListUpdate event");
		const { guild_id } = data;
		const guild = this.app.guilds.get(guild_id);

		if (!guild) {
			console.warn(`[GuildMemberListUpdate] Guild ${guild_id} not found`);
			return;
		}

		guild.updateMemberList(data);
	};

	private onChannelCreate = (data: GatewayChannelCreateDispatchData) => {
		if (data.type === ChannelType.DM || data.type === ChannelType.GroupDM) {
			this.app.privateChannels.add(data);
			return;
		}

		const guild = this.app.guilds.get(data.guild_id!);
		if (!guild) {
			console.warn(
				`[ChannelCreate] Guild ${data.guild_id} not found for channel ${data.id}`,
			);
			return;
		}
		guild.channels.add(data);
	};

	private onChannelDelete = (data: GatewayChannelDeleteDispatchData) => {
		if (data.type === ChannelType.DM || data.type === ChannelType.GroupDM) {
			this.app.privateChannels.remove(data.id);
			return;
		}

		const guild = this.app.guilds.get(data.guild_id!);
		if (!guild) {
			console.warn(
				`[ChannelDelete] Guild ${data.guild_id} not found for channel ${data.id}`,
			);
			return;
		}
		guild.channels.remove(data.id);
	};

	private onMessageCreate = (data: GatewayMessageCreateDispatchData) => {
		const guild = this.app.guilds.get(data.guild_id!);
		if (!guild) {
			console.warn(
				`[MessageCreate] Guild ${data.guild_id} not found for channel ${data.id}`,
			);
			return;
		}
		const channel = guild.channels.get(data.channel_id);
		if (!channel) {
			console.warn(
				`[MessageCreate] Channel ${data.channel_id} not found for message ${data.id}`,
			);
			return;
		}

		channel.messages.add(data);
		this.app.queue.handleIncomingMessage(data);
	};

	private onMessageUpdate = (data: GatewayMessageUpdateDispatchData) => {
		const guild = this.app.guilds.get(data.guild_id!);
		if (!guild) {
			console.warn(
				`[MessageUpdate] Guild ${data.guild_id} not found for channel ${data.id}`,
			);
			return;
		}
		const channel = guild.channels.get(data.channel_id);
		if (!channel) {
			console.warn(
				`[MessageUpdate] Channel ${data.channel_id} not found for message ${data.id}`,
			);
			return;
		}

		channel.messages.update(data as APIMessage);
	};

	private onMessageDelete = (data: GatewayMessageDeleteDispatchData) => {
		const guild = this.app.guilds.get(data.guild_id!);
		if (!guild) {
			console.warn(
				`[MessageDelete] Guild ${data.guild_id} not found for channel ${data.id}`,
			);
			return;
		}
		const channel = guild.channels.get(data.channel_id);
		if (!channel) {
			console.warn(
				`[MessageDelete] Channel ${data.channel_id} not found for message ${data.id}`,
			);
			return;
		}

		channel.messages.remove(data.id);
	};

	private onPresenceUpdate = (data: GatewayPresenceUpdateDispatchData) => {
		this.app.presences.add(data);
	};
}