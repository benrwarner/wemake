// Per-account storage cap: a song's takes count against the account that started it.
// Songs started by guests have no owner and are only limited by the server-wide free-space guard.

export interface QuotaDeps {
  limitBytes: number;
  ownerOf(room: string): number | null;
  ownedRooms(userId: number): string[];
  roomBytes(room: string): number;
}

export type Reservation = { owner: number | null; maxBytes: number; release(): void };

export class Quota {
  // bytes promised to uploads still streaming in, per owner, so parallel uploads can't overshoot
  private reserved = new Map<number, number>();

  constructor(private deps: QuotaDeps) {}

  get limit(): number {
    return this.deps.limitBytes;
  }

  used(userId: number): number {
    let total = this.reserved.get(userId) ?? 0;
    for (const room of this.deps.ownedRooms(userId)) total += this.deps.roomBytes(room);
    return total;
  }

  /**
   * Holds space for an upload of `size` bytes (0 = unknown) to `room`, capped at `maxUpload`.
   * Returns null when the song's owner is out of space. Call release() once the upload ends either way.
   */
  reserve(room: string, size: number, maxUpload: number): Reservation | null {
    const owner = this.deps.ownerOf(room);
    if (owner == null) return { owner, maxBytes: maxUpload, release: () => {} };
    const left = this.deps.limitBytes - this.used(owner);
    const maxBytes = Math.min(maxUpload, left);
    if (maxBytes <= 0 || size > maxBytes) return null;
    const hold = size > 0 ? size : maxBytes;
    this.reserved.set(owner, (this.reserved.get(owner) ?? 0) + hold);
    let done = false;
    return {
      owner,
      maxBytes,
      release: () => {
        if (done) return;
        done = true;
        const rest = (this.reserved.get(owner) ?? 0) - hold;
        if (rest > 0) this.reserved.set(owner, rest);
        else this.reserved.delete(owner);
      },
    };
  }
}
