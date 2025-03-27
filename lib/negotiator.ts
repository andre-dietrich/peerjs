import logger from "./logger";
import type { MediaConnection } from "./mediaconnection";
import type { DataConnection } from "./dataconnection/DataConnection";
import {
	BaseConnectionErrorType,
	ConnectionType,
	PeerErrorType,
	ServerMessageType,
} from "./enums";
import type { BaseConnection, BaseConnectionEvents } from "./baseconnection";
import type { ValidEventTypes } from "eventemitter3";

/**
 * Manages all negotiations between Peers.
 */
export class Negotiator<
	Events extends ValidEventTypes,
	ConnectionType extends BaseConnection<Events | BaseConnectionEvents>,
> {
	constructor(readonly connection: ConnectionType) {}

	/** Returns a PeerConnection object set up correctly (for data, media). */
	startConnection(options: any) {
		const peerConnection = this._startPeerConnection();

		// Set the connection's PC.
		this.connection.peerConnection = peerConnection;

		if (this.connection.type === ConnectionType.Media && options._stream) {
			this._addTracksToConnection(options._stream, peerConnection);
		}

		// What do we need to do now?
		if (options.originator) {
			const dataConnection = this.connection;

			const config: RTCDataChannelInit = { ordered: !!options.reliable };

			const dataChannel = peerConnection.createDataChannel(
				dataConnection.label,
				config,
			);
			dataConnection._initializeDataChannel(dataChannel);

			void this._makeOffer();
		} else {
			void this.handleSDP("OFFER", options.sdp);
		}
	}

	/** Start a PC. */
	private _startPeerConnection(): RTCPeerConnection {
		logger.log("Creating RTCPeerConnection.");

		const peerConnection = new RTCPeerConnection(
			this.connection.provider.options.config,
		);

		this._setupListeners(peerConnection);

		return peerConnection;
	}

	/** Set up various WebRTC listeners. */
	private _setupListeners(peerConnection: RTCPeerConnection) {
		const peerId = this.connection.peer;
		const connectionId = this.connection.connectionId;
		const connectionType = this.connection.type;
		const provider = this.connection.provider;

		// ICE CANDIDATES.
		logger.log("Listening for ICE candidates.");

		peerConnection.onicecandidate = (evt) => {
			if (!evt.candidate || !evt.candidate.candidate) return;

			logger.log(`Received ICE candidates for ${peerId}:`, evt.candidate);

			provider.socket.send({
				type: ServerMessageType.Candidate,
				payload: {
					candidate: evt.candidate,
					type: connectionType,
					connectionId: connectionId,
				},
				dst: peerId,
			});
		};

		peerConnection.oniceconnectionstatechange = () => {
			switch (peerConnection.iceConnectionState) {
				case "failed":
					logger.log(
						"iceConnectionState is failed, closing connections to " + peerId,
					);
					this.connection.emitError(
						BaseConnectionErrorType.NegotiationFailed,
						"Negotiation of connection to " + peerId + " failed.",
					);
					this.connection.close();
					break;
				case "closed":
					logger.log(
						"iceConnectionState is closed, closing connections to " + peerId,
					);
					this.connection.emitError(
						BaseConnectionErrorType.ConnectionClosed,
						"Connection to " + peerId + " closed.",
					);
					this.connection.close();
					break;
				case "disconnected":
					logger.log(
						"iceConnectionState changed to disconnected on the connection with " +
							peerId,
					);
					break;
				case "completed":
					peerConnection.onicecandidate = () => {};
					break;
			}

			this.connection.emit(
				"iceStateChanged",
				peerConnection.iceConnectionState,
			);
		};

		// DATACONNECTION.
		logger.log("Listening for data channel");
		// Fired between offer and answer, so options should already be saved
		// in the options hash.
		peerConnection.ondatachannel = (evt) => {
			logger.log("Received data channel");

			const dataChannel = evt.channel;
			const connection = <DataConnection>(
				provider.getConnection(peerId, connectionId)
			);

			connection._initializeDataChannel(dataChannel);
		};

		// MEDIACONNECTION.
		logger.log("Listening for remote stream");

		peerConnection.ontrack = (evt) => {
			logger.log("Received remote stream");

			const stream = evt.streams[0];
			const connection = provider.getConnection(peerId, connectionId);

			if (connection.type === ConnectionType.Media) {
				const mediaConnection = <MediaConnection>connection;

				this._addStreamToMediaConnection(stream, mediaConnection);
			}
		};
	}

	cleanup(): void {
		logger.log("Cleaning up PeerConnection to " + this.connection.peer);

		const peerConnection = this.connection.peerConnection;

		if (!peerConnection) {
			return;
		}

		// Stop all transceivers/senders tracks
		try {
			// For newer browsers that support transceivers
			if (peerConnection.getTransceivers) {
				peerConnection.getTransceivers().forEach((transceiver) => {
					if (transceiver.sender && transceiver.sender.track) {
						transceiver.sender.track.stop();
					}
					// Also stop receiver tracks if they exist and are local
					if (transceiver.receiver && transceiver.receiver.track) {
						// Only stop receiver tracks if we know they're not from the remote peer
						// (This check is an example - actual implementation might differ)
						if (transceiver.direction === "sendonly") {
							transceiver.receiver.track.stop();
						}
					}
				});
			}
			// Fallback for older implementations
			else if (peerConnection.getSenders) {
				peerConnection.getSenders().forEach((sender) => {
					if (sender.track) {
						sender.track.stop();
					}
				});
			}
		} catch (err) {
			logger.warn("Error stopping tracks", err);
		}

		// Clear all references
		this.connection.peerConnection = null;

		// Properly remove event listeners instead of setting to empty functions
		if (peerConnection.onicecandidate) peerConnection.onicecandidate = null;
		if (peerConnection.oniceconnectionstatechange)
			peerConnection.oniceconnectionstatechange = null;
		if (peerConnection.ondatachannel) peerConnection.ondatachannel = null;
		if (peerConnection.ontrack) peerConnection.ontrack = null;

		// Close data channel with proper error handling
		const dataChannel = this.connection.dataChannel;
		if (dataChannel) {
			try {
				// Remove all event listeners from data channel
				dataChannel.onopen = null;
				dataChannel.onclose = null;
				dataChannel.onmessage = null;
				dataChannel.onerror = null;

				if (dataChannel.readyState !== "closed") {
					dataChannel.close();
				}
			} catch (err) {
				logger.warn("Error closing data channel", err);
			}

			// Clear reference
			this.connection.dataChannel = null;
		}

		// Close peer connection if not already closed
		if (peerConnection.signalingState !== "closed") {
			try {
				peerConnection.close();
			} catch (err) {
				logger.warn("Error closing PeerConnection", err);
			}
		}

		// Manually trigger garbage collection hint (only in environments that support it)
		if (global && global.gc) {
			try {
				global.gc();
			} catch (e) {
				logger.log("Manual GC not available");
			}
		}
	}

	private async _makeOffer(): Promise<void> {
		const peerConnection = this.connection.peerConnection;
		const provider = this.connection.provider;

		try {
			const offer = await peerConnection.createOffer(
				this.connection.options.constraints,
			);

			logger.log("Created offer.");

			try {
				// Apply SDP transform in a separate try-catch for better error reporting
				let processedSdp = offer.sdp;
				if (this.connection.options.sdpTransform) {
					try {
						const transformResult = this.connection.options.sdpTransform(
							offer.sdp,
						);
						// Only use the result if it's a non-empty string
						if (
							typeof transformResult === "string" &&
							transformResult.length > 0
						) {
							processedSdp = transformResult;
							logger.log("Applied sdpTransform to offer");
						} else {
							logger.warn("sdpTransform returned invalid SDP, using original");
						}
					} catch (transformError) {
						provider.emitError(PeerErrorType.WebRTC, transformError);
						logger.error("Error in sdpTransform function:", transformError);
					}
				}

				// Create a new description object with the processed SDP
				const processedOffer = new RTCSessionDescription({
					type: offer.type,
					sdp: processedSdp,
				});

				await peerConnection.setLocalDescription(processedOffer);

				logger.log(
					"Set localDescription:",
					offer,
					`for:${this.connection.peer}`,
				);

				let payload: any = {
					sdp: offer,
					type: this.connection.type,
					connectionId: this.connection.connectionId,
					metadata: this.connection.metadata,
				};

				if (this.connection.type === ConnectionType.Data) {
					const dataConnection = <DataConnection>(<unknown>this.connection);

					payload = {
						...payload,
						label: dataConnection.label,
						reliable: dataConnection.reliable,
						serialization: dataConnection.serialization,
					};
				}

				provider.socket.send({
					type: ServerMessageType.Offer,
					payload,
					dst: this.connection.peer,
				});
			} catch (err) {
				// TODO: investigate why _makeOffer is being called from the answer
				if (
					err !=
					"OperationError: Failed to set local offer sdp: Called in wrong state: kHaveRemoteOffer"
				) {
					provider.emitError(PeerErrorType.WebRTC, err);
					logger.log("Failed to setLocalDescription, ", err);
				}
			}
		} catch (err_1) {
			provider.emitError(PeerErrorType.WebRTC, err_1);
			logger.log("Failed to createOffer, ", err_1);
		}
	}

	private async _makeAnswer(): Promise<void> {
		const peerConnection = this.connection.peerConnection;
		const provider = this.connection.provider;

		try {
			const answer = await peerConnection.createAnswer();
			logger.log("Created answer.");

			try {
				// Apply SDP transform in a separate try-catch for better error reporting
				let processedSdp = answer.sdp;
				if (this.connection.options.sdpTransform) {
					try {
						const transformResult = this.connection.options.sdpTransform(
							answer.sdp,
						);
						// Only use the result if it's a non-empty string
						if (
							typeof transformResult === "string" &&
							transformResult.length > 0
						) {
							processedSdp = transformResult;
							logger.log("Applied sdpTransform to answer");
						} else {
							logger.warn("sdpTransform returned invalid SDP, using original");
						}
					} catch (transformError) {
						provider.emitError(PeerErrorType.WebRTC, transformError);
						logger.error("Error in sdpTransform function:", transformError);
					}
				}

				// Create a new description object with the processed SDP
				const processedAnswer = new RTCSessionDescription({
					type: answer.type,
					sdp: processedSdp,
				});

				await peerConnection.setLocalDescription(processedAnswer);

				logger.log(
					`Set localDescription:`,
					answer,
					`for:${this.connection.peer}`,
				);

				provider.socket.send({
					type: ServerMessageType.Answer,
					payload: {
						sdp: answer,
						type: this.connection.type,
						connectionId: this.connection.connectionId,
					},
					dst: this.connection.peer,
				});
			} catch (err) {
				provider.emitError(PeerErrorType.WebRTC, err);
				logger.log("Failed to setLocalDescription, ", err);
			}
		} catch (err_1) {
			provider.emitError(PeerErrorType.WebRTC, err_1);
			logger.log("Failed to create answer, ", err_1);
		}
	}

	/** Handle an SDP. */
	async handleSDP(type: string, sdp: any): Promise<void> {
		sdp = new RTCSessionDescription(sdp);
		const peerConnection = this.connection.peerConnection;
		const provider = this.connection.provider;

		logger.log("Setting remote description", sdp);

		try {
			await peerConnection.setRemoteDescription(sdp);
			logger.log(`Set remote description ${type} successfully`);

			if (type === "OFFER") {
				await this._makeAnswer();
			}
		} catch (err) {
			const errorMessage = `Failed to set remote ${type} SDP: ${err.message}`;
			logger.error(errorMessage, err);

			// Categorize error for better handling
			if (err.name === "InvalidStateError") {
				provider.emitError(
					PeerErrorType.WebRTC,
					`Invalid signaling state: ${peerConnection.signalingState}. ${errorMessage}`,
				);
			} else if (err.name === "InvalidAccessError") {
				provider.emitError(
					PeerErrorType.WebRTC,
					`Invalid SDP format or unsupported configuration. ${errorMessage}`,
				);
			} else {
				provider.emitError(PeerErrorType.WebRTC, errorMessage);
			}

			this.connection.close();
		}
	}

	/** Handle a candidate. */
	async handleCandidate(ice: RTCIceCandidate) {
		logger.log(`handleCandidate:`, ice);

		try {
			await this.connection.peerConnection.addIceCandidate(ice);
			logger.log(`Added ICE candidate for:${this.connection.peer}`);
		} catch (err) {
			this.connection.provider.emitError(PeerErrorType.WebRTC, err);
			logger.log("Failed to handleCandidate, ", err);
		}
	}

	private _addTracksToConnection(
		stream: MediaStream,
		peerConnection: RTCPeerConnection,
	): void {
		logger.log(`add tracks from stream ${stream.id} to peer connection`);

		if (!peerConnection.addTrack) {
			return logger.error(
				`Your browser does't support RTCPeerConnection#addTrack. Ignored.`,
			);
		}

		stream.getTracks().forEach((track) => {
			peerConnection.addTrack(track, stream);
		});
	}

	private _addStreamToMediaConnection(
		stream: MediaStream,
		mediaConnection: MediaConnection,
	): void {
		logger.log(
			`add stream ${stream.id} to media connection ${mediaConnection.connectionId}`,
		);

		mediaConnection.addStream(stream);
	}
}
