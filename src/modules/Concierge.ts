import { DateTime, Duration } from "luxon";
import type { MembershipEvent } from "matrix-bot-sdk";
import type { StateEvent } from "../lib/matrix";
import Module from "../lib/Module";
import type { Scheduled } from "../lib/scheduling";

interface ScheduledNudge extends Scheduled {
  children: Set<string>;
}

const nudgeDelay = Duration.fromObject({ minutes: 1 });

export default () =>
  class Concierge extends Module {
    #scheduledNudges: Map<string, ScheduledNudge> = new Map();

    public async start() {
      this.patch.on("membership", this.handleMembership.bind(this));
    }

    public async stop() {
      for (const [key, scheduled] of this.#scheduledNudges.entries()) {
        clearTimeout(scheduled.timer);
        this.#scheduledNudges.delete(key);
      }
    }

    private async getMembership(
      room: string,
      user: string
    ): Promise<MembershipEvent["membership"] | undefined> {
      this.debug("🚪 Get memberships", { room });
      const memberships = await this.matrix.getRoomMembers(room);

      return memberships.find((m) => m.membershipFor === user)?.membership;
    }

    private async handleMembership(
      room: string,
      { state_key: user, content: { membership } }: StateEvent<"m.room.member">
    ) {
      this.debug("🚪 Membership", { room, user, membership });

      if (membership === "join" || membership === "leave") {
        const space = (await this.matrix.getRoomState(room))
          .filter((e): e is StateEvent<"m.space.parent"> => e.type === "m.space.parent")
          .find((e) => e.content.canonical)?.state_key;

        if (space) {
          if (membership === "join") this.scheduleNudge(user, space, room);
          else this.unscheduleNudge(user, space, room);
        }
      }
    }

    private scheduleNudge(user: string, space: string, child: string) {
      const key = `${space}/${user}`;
      const existing = this.#scheduledNudges.get(key);

      const at = DateTime.now().plus(nudgeDelay);
      const delay = nudgeDelay.toMillis();

      if (existing) {
        this.debug("🕓 Reschedule nudge", { space, user, child, at: at.toISO() });
        clearTimeout(existing.timer);
        existing.at = at;
        existing.children.add(child);
        existing.timer = setTimeout(() => {
          this.#scheduledNudges.delete(key);

          this.debug("🕓 Run scheduled nudge", { space, user, at: at.toISO() });
          this.tryNudge(user, space);
        }, delay);
        this.#scheduledNudges.set(key, existing);
      } else {
        this.debug("🕓 Schedule nudge", { space, user, child, at: at.toISO() });
        const scheduled: ScheduledNudge = {
          at,
          children: new Set([child]),
          timer: setTimeout(() => {
            this.#scheduledNudges.delete(key);

            this.debug("🕓 Run scheduled nudge", { space, user, at: at.toISO() });
            this.tryNudge(user, space);
          }, delay),
        };
        this.#scheduledNudges.set(key, scheduled);
      }
    }

    private async tryNudge(user: string, space: string) {
      const membership = await this.getMembership(space, user);
      if (membership) return this.debug("🧭 No nudge", { user, space, membership });

      this.info("🧭 Nudge", { user, space });
      await this.matrix.inviteUser(user, space);
    }

    private unscheduleNudge(user: string, space: string, child: string) {
      const key = `${space}/${user}`;
      const existing = this.#scheduledNudges.get(key);
      if (!existing) return;

      if (existing.children.delete(child))
        this.debug("🕓 Remove nudge trigger", { space, user, child });

      if (existing.children.size === 0) {
        this.debug("🕓 Unschedule nudge", { space, user, at: existing.at.toISO() });
        clearTimeout(existing.timer);
        this.#scheduledNudges.delete(key);
      }
    }
  };
