/* Test seam: a mock raw interface socket.
 *
 * GRETAP owns the data path in the kernel, so the legacy raw-socket transport
 * is gone. This mock exists purely so the relay-box module's tests (and any
 * caller that injects an `IfaceRawSocket`) keep compiling and running: the
 * no-op relay accepts the socket and simply never reads from it.
 */

export interface IfaceRawSocket {
    /** Readable stream of incoming raw IP datagrams (header included). */
    readStream(): ReadableStream<Uint8Array>;
    /** Send a full IPv4 packet out the bound interface. Returns bytes written. */
    send(packet: Uint8Array, dstIp: string): number;
    /** Release the underlying fd. */
    close(): void;
}

export interface OpenIfaceRawSocketOptions {
    /** Receive ring size to request (bytes). */
    rcvbufBytes?: number;
}

/** A mock `IfaceRawSocket` recording sent packets and delivering queued ones. */
export function makeMockIfaceRawSocket(): {
    sent: Array<{ packet: Uint8Array; dstIp: string }>;
    inbound: Uint8Array[];
    push(packet: Uint8Array): void;
    closed: boolean;
} & IfaceRawSocket {
    const sent: Array<{ packet: Uint8Array; dstIp: string }> = [];
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    let closed = false;

    return {
        sent,
        /** Pre-queued inbound packets (satisfies the `inbound` field). */
        inbound: queue,
        get closed() {
            return closed;
        },
        readStream(): ReadableStream<Uint8Array> {
            return new ReadableStream<Uint8Array>({
                async pull(controller) {
                    if (queue.length > 0) {
                        controller.enqueue(queue.shift()!);
                        return;
                    }
                    if (closed) {
                        controller.close();
                        return;
                    }
                    await new Promise<void>((resolve) => {
                        waiter = resolve;
                    });
                    if (closed) {
                        controller.close();
                        return;
                    }
                    controller.enqueue(queue.shift()!);
                },
                cancel() {
                    closed = true;
                },
            });
        },
        /** Queue a packet to deliver to the next read in the read loop. */
        push(packet: Uint8Array): void {
            queue.push(packet);
            const w = waiter;
            waiter = null;
            w?.();
        },
        send(packet: Uint8Array, dstIp: string): number {
            sent.push({ packet: Uint8Array.from(packet), dstIp });
            return packet.length;
        },
        close(): void {
            closed = true;
            const w = waiter;
            waiter = null;
            w?.();
        },
    };
}
