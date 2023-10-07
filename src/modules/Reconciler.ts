import Bottleneck from "bottleneck";
import isEqual from "lodash.isequal";
import mergeWith from "lodash.mergewith";
import { DateTime, Duration } from "luxon";
import type {
  MatrixProfileInfo,
  PowerLevelsEventContent as PowerLevels,
  Space,
  SpaceEntityMap as Children,
} from "matrix-bot-sdk";
import MarkdownIt from "markdown-it";
import { assert, Equals } from "tsafe";
import type { Handler } from "./Commands";
import type Client from "../lib/Client";
import type { RoomCreateOptions } from "../lib/Client";
import {
  IStateEvent,
  mergeWithMatrixState,
  MessageEvent,
  moderatorLevel,
  orNone,
  resolvePreset,
  StateEvent,
  StateEventInput,
} from "../lib/matrix";
import Module from "../lib/Module";
import * as OSEM from "../lib/Osem";
import type { Plan, SessionGroupId } from "../lib/Plan";
import type { Scheduled } from "../lib/scheduling";
import { expect, maxDelay, unimplemented } from "../lib/utilities";
import type Patch from "../Patch";

const md = new MarkdownIt();

interface Room extends Plan.Room {
  id: string;
  local: string;
  order: string;
}

interface ListedSpace extends Space {
  children: Children;
  local: string;
}

interface Session extends OSEM.Event {
  day: number;
  open: DateTime;
}

export type IntroEvent = IStateEvent<"org.seagl.patch.intro", { message?: string }>;

export type RedirectEvent = IStateEvent<"org.seagl.patch.redirect", { message?: string }>;

export type TagEvent = IStateEvent<"org.seagl.patch.tag", { tag?: string }>;

const jitsiUrl =
  "https://app.element.io/jitsi.html?confId=$conferenceId#conferenceDomain=$domain&conferenceId=$conferenceId&displayName=$matrix_display_name&avatarUrl=$matrix_avatar_url&userId=$matrix_user_id&roomId=$matrix_room_id&theme=$theme&roomName=$roomName";
const reconcilePeriod = Duration.fromObject({ hours: 1 });
const widgetLayout = {
  widgets: { "org.seagl.patch": { container: "top", height: 25, width: 100, index: 0 } },
};

const compareSessions = (a: Session, b: Session): number =>
  a.beginning !== b.beginning
    ? a.beginning.valueOf() - b.beginning.valueOf()
    : a.end !== b.end
    ? a.end.valueOf() - b.end.valueOf()
    : a.title.localeCompare(b.title);
const sortKey = (index: number): string => String(10 * (1 + index)).padStart(4, "0");

export default (plan: Plan) =>
  class Reconciler extends Module {
    #limiter: Bottleneck;
    #privateChildrenByParent: Map<string, Set<string>>;
    #roomByTag: Map<string, string>;
    #scheduledReconcile: Scheduled | undefined;
    #scheduledRegroups: Map<Room["id"], Scheduled>;
    #sessionGroups: { [id in SessionGroupId]?: ListedSpace };

    public constructor(patch: Patch, matrix: Client) {
      super(patch, matrix);

      this.#limiter = new Bottleneck({ maxConcurrent: 1 });
      this.#privateChildrenByParent = new Map();
      this.#roomByTag = new Map();
      this.#scheduledRegroups = new Map();
      this.#sessionGroups = {};
    }

    public async start() {
      for (const room of await this.matrix.getJoinedRooms()) {
        const tag = await this.getTag(room);
        if (tag) this.#roomByTag.set(tag, room);
      }

      await this.reconcile();

      this.patch.on("membership", this.handleMembership);
      this.patch.on("command.admin.sync", this.handleSyncCommand);
    }

    public async stop() {
      if (this.#scheduledReconcile) {
        clearTimeout(this.#scheduledReconcile.timer);
        this.#scheduledReconcile = undefined;
      }

      for (const [room, scheduled] of this.#scheduledRegroups.entries()) {
        clearTimeout(scheduled.timer);
        this.#scheduledRegroups.delete(room);
      }

      this.patch.off("membership", this.handleMembership);
      this.patch.off("command.admin.sync", this.handleSyncCommand);
    }

    private getAccessOptions({
      isPrivate,
      isSpace,
      parent,
    }: {
      isPrivate: boolean;
      isSpace: boolean;
      parent: Room | undefined;
    }): Pick<RoomCreateOptions, "initial_state" | "preset"> {
      return {
        preset: isPrivate || parent?.private ? "private_chat" : "public_chat",
        initial_state: isPrivate
          ? [{ type: "m.room.join_rules", content: { join_rule: "knock" } }]
          : parent?.private
          ? [
              {
                type: "m.room.join_rules",
                content: {
                  join_rule: "knock_restricted",
                  allow: [{ type: "m.room_membership", room_id: parent.id }],
                },
              },
            ]
          : isSpace
          ? [
              {
                type: "m.room.history_visibility",
                content: { history_visibility: "world_readable" },
              },
            ]
          : [],
      };
    }

    private async getInheritedUsers(): Promise<PowerLevels["users"]> {
      if (!plan.inheritUserPowerLevels) return undefined;

      const users: PowerLevels["users"] = {};

      for (const [room, { raiseTo = 0 }] of Object.entries(plan.inheritUserPowerLevels)) {
        const id = await this.matrix.resolveRoom(room);
        const { users: original = {} } = expect(
          await this.matrix.getRoomStateEvent<StateEvent<"m.room.power_levels">>(
            id,
            "m.room.power_levels"
          ),
          "power levels"
        );

        this.info("🛡️ Inherit user power levels", { room, users: original });
        for (const [user, level] of Object.entries(original)) {
          users[user] = Math.max(users[user] ?? 0, level, raiseTo);
        }
      }

      return users;
    }

    private async getModerators(room: string): Promise<string[]> {
      const powerLevels = expect(
        await this.matrix.getRoomStateEvent<StateEvent<"m.room.power_levels">>(
          room,
          "m.room.power_levels"
        ),
        "power levels"
      );

      return Object.entries(powerLevels.users ?? {})
        .filter(([_user, level]) => level >= moderatorLevel)
        .map(([user]) => user);
    }

    private async getNotice(
      room: string,
      id: string
    ): Promise<MessageEvent<"m.room.message"> | undefined> {
      this.debug("🪧 Get notice", { room, id });
      return await this.matrix.getEvent(room, id).catch(orNone);
    }

    private getPowerLevels(
      inherited: PowerLevels["users"],
      room: Plan.Room
    ): PowerLevels {
      return {
        ...plan.powerLevels,
        events: {
          ...plan.powerLevels.events,
          ...(room.widget
            ? { "im.vector.modular.widgets": 99, "io.element.widgets.layout": 99 }
            : {}),
        },
        users: {
          ...inherited,
          ...plan.powerLevels.users,
        },
        ...(room.readOnly || room.redirect ? { events_default: moderatorLevel } : {}),
      };
    }

    private async getRootMessage(room: string, id: string): Promise<string> {
      this.debug("💬 Get message", { room, id });
      const message: MessageEvent<"m.room.message"> | undefined = await this.matrix
        .getEvent(room, id)
        .catch(orNone);

      const relation = message?.content["m.relates_to"];
      const next = relation?.rel_type === "m.replace" && relation.event_id;

      return next ? this.getRootMessage(room, next) : id;
    }

    private async getTag(room: string): Promise<string | undefined> {
      const tag = (
        await this.matrix
          .getRoomStateEvent<TagEvent>(room, "org.seagl.patch.tag", "")
          .catch(orNone)
      )?.tag;

      this.debug("🔖 Tag", { room, tag });
      return tag;
    }

    private handleMembership = async (
      room: string,
      { state_key: user, content: { membership } }: StateEvent<"m.room.member">
    ) => {
      this.debug("🚪 Membership", { room, user, membership });

      if (
        membership === "join" &&
        this.#privateChildrenByParent.has(room) &&
        (await this.getModerators(room)).includes(user)
      ) {
        for (const child of this.#privateChildrenByParent.get(room) ?? []) {
          const memberships = await this.matrix.getRoomMembers(child);

          if (!memberships.some((m) => m.membershipFor === user)) {
            this.info("🔑 Invite space moderator to private room", {
              space: room,
              moderator: user,
              room: child,
            });
            await this.tryInvite(child, user);
          }
        }
      }
    };

    private handleSyncCommand: Handler = async ({ event, room }) => {
      const started = "Synchronizing space with data sources…";
      const completed = "Synchronized space with data sources";

      const start = await this.matrix.replyNotice(room, event, started);
      const complete = () => this.matrix.replaceNotice(room, start, { body: completed });

      this.reconcile().then(complete);
    };

    private async listSpace(space: Space, local: string): Promise<ListedSpace> {
      this.debug("🏘️ List space", { local });
      return Object.assign(space, { children: await space.getChildEntities(), local });
    }

    private localToAlias(local: string): string {
      return local.startsWith("SeaGL2022") && local.endsWith("seattlematrix.org")
        ? `#${local.replace(/^SeaGL/, "")}:seagl.org`
        : `#${local}:${plan.homeserver}`;
    }

    private async reconcile(now = DateTime.local({ zone: plan.timeZone })) {
      await this.#limiter.schedule(async () => {
        this.scheduleReconcile(now.plus(reconcilePeriod));

        this.info("🔃 Reconcile");
        await this.reconcileProfile(plan.steward);
        const inheritedUsers = await this.getInheritedUsers();
        if (plan.rooms) await this.reconcileRooms(inheritedUsers, plan.rooms);
        if (plan.sessions)
          await this.reconcileSessions(plan.sessions, inheritedUsers, now);
        this.debug("🔃 Completed reconciliation");
      });
    }

    private async reconcileAlias(room: Room, expected: string) {
      if (expected.endsWith(plan.homeserver)) {
        const resolved = await this.resolveAlias(expected);

        if (resolved && resolved !== room.id) {
          this.info("🏷️ Reassign alias", {
            alias: expected,
            from: resolved,
            to: room.id,
          });
          await this.matrix.deleteRoomAlias(expected);
          await this.matrix.createRoomAlias(expected, room.id);
        } else if (!resolved) {
          this.info("🏷️ Create alias", { alias: expected, room: room.local });
          await this.matrix.createRoomAlias(expected, room.id);
        }
      }

      const content = await this.matrix
        .getRoomStateEvent<StateEvent<"m.room.canonical_alias">>(
          room.id,
          "m.room.canonical_alias"
        )
        .catch(orNone);

      const [from, to] = [content?.alias, expected];
      if (from !== to) {
        this.info("🏷️ Update canonical alias", { room: room.local, from, to });
        this.reconcileState(room, {
          type: "m.room.canonical_alias",
          content: { ...content, alias: to },
        });
      }
    }

    private async reconcileAvatar(room: Room) {
      const content = { url: this.resolveAvatar(room.avatar) };
      await this.reconcileState(room, { type: "m.room.avatar", content });
    }

    private async reconcileChildhood(space: ListedSpace, room: Room, include = true) {
      const { id, local: child, order, suggested = false } = room;
      const actual = space.children[id]?.content;
      if (!include) return actual && (await this.removeFromSpace(space, room));

      const expected = { order, suggested };

      if (actual) {
        let changed = false;
        mergeWith(actual, expected, (from, to, option) => {
          if (typeof to === "object" || !(from || to) || from === to) return;

          this.info("🏘️ Update childhood", {
            space: space.local,
            child,
            option,
            from,
            to,
          });
          changed = true;
        });

        if (changed) {
          this.debug("🏘️ Set childhood", { space: space.local, child });
          await space.addChildRoom(id, actual);
        }
      } else {
        this.info("🏘️ Add to space", { space: space.local, child });
        await space.addChildRoom(id, { via: [plan.homeserver], ...expected });
      }
      await this.reconcileState(room, {
        type: "m.space.parent",
        state_key: space.roomId,
        content: { canonical: true, via: [plan.homeserver] },
      });
      const privateChildren =
        this.#privateChildrenByParent.get(space.roomId) ?? new Set();
      privateChildren[room.private ? "add" : "delete"](id);
      this.#privateChildrenByParent.set(space.roomId, privateChildren);
    }

    private async reconcileChildren(space: ListedSpace, expected: Room[]) {
      const actual = Object.keys(space.children);
      const ids = new Set(expected.map((r) => r.id));

      for (const a of actual) if (!ids.has(a)) await this.removeFromSpace(space, a);
      for (const room of expected) await this.reconcileChildhood(space, room);
    }

    private async reconcileControlRoom(room: Room) {
      if (this.patch.controlRoom === room.id && !room.control) {
        this.warn("🚦 Unlink control room", { room: this.patch.controlRoom });
        this.patch.controlRoom = undefined;
      } else if (room.control && this.patch.controlRoom !== room.id) {
        this.info("🚦 Update control room", {
          from: this.patch.controlRoom,
          to: room.id,
        });
        this.patch.controlRoom = room.id;
      }
    }

    private async reconcileExistence(
      inheritedUsers: PowerLevels["users"],
      local: string,
      expected: Plan.Room,
      parent?: Room
    ): Promise<[string | undefined, boolean]> {
      const alias = this.localToAlias(local);

      const existingByTag = expected.tag && this.resolveTag(expected.tag);
      const existingByAlias = await this.resolveAlias(alias);
      if (
        existingByTag &&
        existingByAlias &&
        existingByAlias !== existingByTag &&
        alias.endsWith(plan.homeserver)
      ) {
        this.info("🏷️ Delete alias", { alias });
        await this.matrix.deleteRoomAlias(alias);
      }
      const existing = existingByTag ?? existingByAlias;

      if (expected.destroy) {
        if (existing) {
          this.info("🏷️ Delete alias", { alias });
          await this.matrix.deleteRoomAlias(alias);

          const reason = "Decommissioning room";
          const members = await this.matrix.getJoinedRoomMembers(existing);
          for (const user of members) {
            if (user === plan.steward.id) continue;

            this.info("🚪 Kick user", { room: existing, user, reason });
            await this.matrix.kickUser(user, existing, reason);
          }

          this.info("🚪 Leave room", { room: existing });
          await this.matrix.leaveRoom(existing);

          this.debug("📇 Forget room", { room: existing });
          await this.matrix.forgetRoom(existing);
        }

        return [undefined, false];
      } else {
        if (existing) return [existing, false];

        this.info("🏠 Create room", { local });
        const isPrivate = Boolean(expected.private);
        const isSpace = Boolean(expected.children);
        const avatar = this.resolveAvatar(expected.avatar);
        const tagEvent = expected.tag && {
          type: "org.seagl.patch.tag" as const,
          content: { tag: expected.tag },
        };
        const created = await this.matrix.createRoom(
          mergeWithMatrixState<RoomCreateOptions, Partial<RoomCreateOptions>>(
            {
              room_version: plan.defaultRoomVersion,
              room_alias_name: local,
              name: expected.name,
              power_level_content_override: this.getPowerLevels(inheritedUsers, expected),
              initial_state: [
                { type: "m.room.avatar", content: { url: avatar } },
                { type: "m.room.canonical_alias", content: { alias } },
                ...(tagEvent ? [tagEvent] : []),
              ],
              ...(expected.topic ? { topic: expected.topic } : {}),
              ...(isSpace ? { creation_content: { type: "m.space" } } : {}),
            },
            this.getAccessOptions({ isPrivate, isSpace, parent })
          )
        );
        if (expected.tag) this.#roomByTag.set(expected.tag, created);
        return [created, true];
      }
    }

    private async reconcileIntro(room: Room) {
      const redactReason = "Removed introduction";

      const body = room.intro
        ? { html: md.render(room.intro), text: room.intro }
        : undefined;

      const type = "org.seagl.patch.intro";
      const event = await this.matrix
        .getRoomStateEvent<IntroEvent>(room.id, type)
        .catch(orNone);
      const message = await this.reconcileNotice(
        room,
        event?.message,
        body,
        redactReason
      );

      await this.reconcileState(room, { type, content: message ? { message } : {} });
    }

    private async reconcileInvitations(child: Room, parent?: Room) {
      if (!child.private) return;

      this.debug("🛡️ List moderators", { room: (parent ?? child).local });
      const moderators = await this.getModerators((parent ?? child).id);

      this.debug("🚪 Get memberships", { room: child.local });
      const childMemberships = await this.matrix.getRoomMembers(child.id);

      for (const { membership, membershipFor: recipient, sender } of childMemberships) {
        if (
          membership === "invite" &&
          sender === plan.steward.id &&
          !moderators.includes(recipient)
        ) {
          this.info("🔑 Withdraw invitation", { room: child.local, recipient });
          await this.matrix.sendStateEvent(child.id, "m.room.member", recipient, {
            membership: "leave",
          });
        }
      }

      if (parent) this.debug("🚪 Get memberships", { space: parent.local });
      const parentMemberships = parent && (await this.matrix.getRoomMembers(parent.id));

      for (const moderator of moderators) {
        if (
          (!parentMemberships ||
            parentMemberships.some(
              (m) => m.membershipFor === moderator && m.membership === "join"
            )) &&
          !childMemberships.some((m) => m.membershipFor === moderator)
        ) {
          this.info("🔑 Invite moderator to private room", {
            moderator,
            room: child.local,
          });
          await this.tryInvite(child.id, moderator);
        }
      }
    }

    private async reconcileName(room: Room) {
      const content = { name: room.name };
      await this.reconcileState(room, { type: "m.room.name", content });
    }

    private async reconcileNotice(
      { id: room }: Room,
      id: string | undefined,
      expected: { html?: string; text: string } | undefined,
      redactionReason: string
    ): Promise<string | undefined> {
      if (!expected) {
        if (id) await this.redactNotice(room, id, redactionReason);
        return;
      }

      const actual = id && (await this.getNotice(room, id))?.content.body;
      if (actual === expected.text) return id;

      if (actual) {
        return await this.replaceNotice(room, id, expected);
      } else {
        this.info("🪧 Notice", { room, body: expected });
        let content: MessageEvent<"m.room.message">["content"];
        if (expected.html) {
          content = {
            msgtype: "m.notice",
            body: expected.text,
            format: "org.matrix.custom.html",
            formatted_body: expected.html,
          };
        } else {
          content = {
            msgtype: "m.notice",
            body: expected.text,
          };
        }
        return await this.matrix.sendMessage(room, content);
      }
    }

    private async reconcilePowerLevels(inheritedUsers: PowerLevels["users"], room: Room) {
      const expected = this.getPowerLevels(inheritedUsers, room);

      this.debug("🛡️ Get power levels", { room: room.local });
      const actual = expect(
        await this.matrix.getRoomStateEvent<StateEvent<"m.room.power_levels">>(
          room.id,
          "m.room.power_levels"
        ),
        "power levels"
      );
      let changed = false;

      mergeWith(actual, expected, (from, to, ability) => {
        if (typeof to === "object" || from === to) return;

        this.info("🛡️ Update power level", { room: room.local, ability, from, to });
        changed = true;
      });

      if (changed) {
        this.debug("🛡️ Set power levels", { room: room.local, content: actual });
        await this.matrix.sendStateEvent(room.id, "m.room.power_levels", "", actual);
      }
    }

    private async reconcilePrivacy(room: Room, parent: Room | undefined) {
      type ImplementedFor = "initial_state" | "preset";

      const isPrivate = Boolean(room.private);
      const isSpace = Boolean(room.children);
      const options = this.getAccessOptions({ isPrivate, isSpace, parent });
      const expected = mergeWithMatrixState(resolvePreset(options.preset), options);
      assert<Equals<typeof expected, Pick<RoomCreateOptions, ImplementedFor>>>();

      if (expected.initial_state)
        for (const event of expected.initial_state)
          await this.reconcileState(room, event);
    }

    private async reconcileProfile({ avatar, name }: Plan["steward"]) {
      const user = plan.steward.id;

      this.debug("👤 Get profile", { user });
      const actual: MatrixProfileInfo = await this.matrix.getUserProfile(user);

      if (!(actual.displayname === name)) {
        this.info("👤 Set display name", { user, from: actual.displayname, to: name });
        await this.matrix.setDisplayName(name);
      }

      if (avatar) {
        const url = this.resolveAvatar(avatar);
        if (!(actual.avatar_url === url)) {
          this.info("👤 Set avatar", { user, from: actual.avatar_url, to: url });
          await this.matrix.setAvatarUrl(url);
        }
      }
    }

    private async reconcileRedirect(room: Room) {
      const alias = room.redirect && this.localToAlias(room.redirect);
      const body = alias ? { text: `This event takes place in ${alias}.` } : undefined;
      const redactReason = "Removed redirect";

      const type = "org.seagl.patch.redirect";
      const event = await this.matrix
        .getRoomStateEvent<RedirectEvent>(room.id, type)
        .catch(orNone);
      const message = await this.reconcileNotice(
        room,
        event?.message,
        body,
        redactReason
      );

      await this.reconcileState(room, { type, content: message ? { message } : {} });
    }

    private async reconcileRoom(
      inheritedUsers: PowerLevels["users"],
      local: string,
      order: string,
      expected: Plan.Room,
      parent?: Room
    ): Promise<Room | undefined> {
      const [id, created] = await this.reconcileExistence(
        inheritedUsers,
        local,
        expected,
        parent
      );

      if (!id) {
        if (typeof expected.children === "object")
          await this.reconcileRooms(inheritedUsers, expected.children);

        return undefined;
      }

      const room = { ...expected, id, local, order };

      if (!created) {
        await this.reconcileTag(room);
        await this.reconcileAlias(room, this.localToAlias(local));
        await this.reconcilePowerLevels(inheritedUsers, room);
        await this.reconcilePrivacy(room, parent);
        await this.reconcileAvatar(room);
        await this.reconcileName(room);
        await this.reconcileTopic(room);
      }

      await this.reconcileWidget(room);
      await this.reconcileRedirect(room);
      await this.reconcileIntro(room);

      if (expected.children) {
        this.debug("🏘️ Get space", { local });
        const space = await this.matrix.getSpace(id);

        if (typeof expected.children === "string") {
          this.#sessionGroups[expected.children] = await this.listSpace(space, local);
        } else {
          await this.reconcileChildren(
            await this.listSpace(space, local),
            await this.reconcileRooms(inheritedUsers, expected.children, room)
          );
        }
      }

      await this.reconcileControlRoom(room);
      await this.reconcileInvitations(room, parent);

      return room;
    }

    private async reconcileRooms(
      inheritedUsers: PowerLevels["users"],
      expected: Plan.Rooms,
      parent?: Room
    ): Promise<Room[]> {
      const rooms = [];

      for (const [index, [local, plan]] of Object.entries(expected).entries()) {
        const order = sortKey(index);
        const room = await this.reconcileRoom(inheritedUsers, local, order, plan, parent);

        if (room) rooms.push(room);
      }

      return rooms;
    }

    private async reconcileSessions(
      sp: Plan.Sessions,
      inheritedUsers: PowerLevels["users"],
      now: DateTime
    ) {
      const ignore = new Set(sp.ignore ?? []);

      this.debug("📅 Get sessions", { conference: sp.conference });
      const osemEvents = await OSEM.getEvents(sp.conference);
      const startOfDay = DateTime.min(...osemEvents.map((e) => e.beginning)).startOf(
        "day"
      );
      const sessions = osemEvents
        .filter((e) => !ignore.has(e.id))
        .map((event) => ({
          ...event,
          day: event.beginning.startOf("day").diff(startOfDay, "days").days,
          open: event.beginning.minus({ minutes: sp.openEarly }),
        }));
      sessions.sort(compareSessions);
      if (sp.demo) {
        const dt = DateTime.fromISO(sp.demo, { zone: plan.timeZone });
        const offset = now.startOf("day").diff(dt, "days");
        this.info("📅 Override conference date", {
          from: dt.toISODate(),
          to: now.toISODate(),
        });
        for (const session of sessions) {
          const to = session.beginning.plus(offset);
          this.debug("📅 Override session time", {
            id: session.id,
            from: session.beginning.toISO(),
            to: to.toISO(),
          });
          session.open = session.open.plus(offset);
          session.beginning = to;
          session.end = session.end.plus(offset);
        }
      }

      for (const [index, session] of sessions.entries()) {
        const suffix = sp.suffixes?.[session.id] ?? `session-${session.id}`;
        const redirect = sp.redirects?.[session.id];
        const topic = sp.topic;
        const intro = sp.intro?.replace(/\$URL\b/, session.url);
        const widget = sp.widgets?.[session.room]?.[session.day];

        const local = `${sp.prefix}${suffix}`;
        const room = await this.reconcileRoom(inheritedUsers, local, sortKey(index), {
          name: `${session.beginning.toFormat("EEE HH:mm")} ${session.title}`,
          tag: `osem-event-${session.id}`,
          ...(intro ? { intro } : {}),
          ...(redirect ? { redirect } : {}),
          ...(topic ? { topic } : {}),
          ...(widget ? { widget } : {}),
        });

        if (room) await this.reconcileSessionGroups(room, session, now);
      }
    }

    private async reconcileSessionGroups(room: Room, session: Session, now: DateTime) {
      const {
        CURRENT_SESSIONS: current,
        FUTURE_SESSIONS: future,
        PAST_SESSIONS: past,
      } = this.#sessionGroups;

      const [opened, ended] = [session.open <= now, session.end <= now];
      const [isFuture, isCurrent, isPast] = [!opened, opened && !ended, ended];

      if (future) await this.reconcileChildhood(future, room, isFuture);
      if (current) await this.reconcileChildhood(current, room, isCurrent);
      if (past) await this.reconcileChildhood(past, room, isPast);

      if (isCurrent) this.scheduleRegroup(room, session, session.end);
      if (isFuture) this.scheduleRegroup(room, session, session.open);
    }

    private async reconcileState(
      idOrRoom: string | Room,
      expected: StateEventInput
    ): Promise<boolean> {
      const id = typeof idOrRoom === "string" ? idOrRoom : idOrRoom.id;
      const room = typeof idOrRoom === "string" ? idOrRoom : idOrRoom.local;

      const { type, state_key: key, content: to } = expected;
      this.debug("🗄️ Get state", { room, type, key });
      const from = await this.matrix.getRoomStateEvent(id, type, key).catch(orNone);

      if (
        (Object.keys(from ?? {}).length > 0 || Object.keys(to).length > 0) &&
        !isEqual(from, to)
      ) {
        this.info("🗄️ Set state", { room, type, key, from, to });
        await this.matrix.sendStateEvent(id, type, key ?? "", to);
        return true;
      }

      return false;
    }

    private async reconcileTag(room: Room) {
      const changed = await this.reconcileState(room, {
        type: "org.seagl.patch.tag",
        content: room.tag ? { tag: room.tag } : {},
      });
      if (changed && room.tag) this.#roomByTag.set(room.tag, room.id);
    }

    private async reconcileTopic(room: Room) {
      const content = room.topic && { topic: room.topic };
      if (content) await this.reconcileState(room, { type: "m.room.topic", content });
    }

    private async reconcileWidget(room: Room) {
      await this.reconcileState(room, {
        type: "im.vector.modular.widgets",
        state_key: "org.seagl.patch",
        content: room.widget
          ? {
              avatar_url: this.resolveAvatar(room.widget.avatar),
              creatorUserId: plan.steward.id,
              name: room.widget.name ?? room.name,
              ...("custom" in room.widget
                ? { type: "customwidget", url: room.widget.custom }
                : "jitsi" in room.widget
                ? {
                    type: "jitsi",
                    url: jitsiUrl,
                    data: {
                      domain: plan.jitsiDomain ?? "meet.jit.si",
                      conferenceId: room.widget.jitsi.id,
                      roomName: room.widget.jitsi.name,
                    },
                  }
                : unimplemented(room.widget)),
            }
          : {},
      });

      await this.reconcileState(room, {
        type: "io.element.widgets.layout",
        content: room.widget ? widgetLayout : {},
      });
    }

    private async redactNotice(
      room: string,
      id: string,
      reason: string
    ): Promise<string> {
      const root = await this.getRootMessage(room, id);

      this.info("🪧 Redact notice", { room, id, root, reason });
      return await this.matrix.redactEvent(room, root, reason);
    }

    private async removeFromSpace(space: ListedSpace, idOrRoom: string | Room) {
      const id = typeof idOrRoom === "string" ? idOrRoom : idOrRoom.id;
      const child = typeof idOrRoom === "string" ? idOrRoom : idOrRoom.local;

      this.info("🏘️ Remove from space", { space: space.local, child });
      await space.removeChildRoom(id);
      await this.reconcileState(idOrRoom, {
        type: "m.space.parent",
        state_key: space.roomId,
        content: {},
      });
      const privateChildren = this.#privateChildrenByParent.get(space.roomId);
      if (privateChildren)
        if (privateChildren.delete(id))
          this.#privateChildrenByParent.set(space.roomId, privateChildren);
    }

    private async replaceNotice(
      room: string,
      id: string,
      { html, text }: { html?: string; text: string }
    ): Promise<string> {
      const root = await this.getRootMessage(room, id);

      this.info("🪧 Replace notice", { room, id, root, text, html });
      return await this.matrix.replaceMessage(room, root, {
        msgtype: "m.notice",
        body: text,
        ...(html ? { format: "org.matrix.custom.html", formatted_body: html } : {}),
      });
    }

    private async resolveAlias(alias: string): Promise<string | undefined> {
      this.debug("🏷️ Resolve alias", { alias });
      return (await this.matrix.lookupRoomAlias(alias).catch(orNone))?.roomId;
    }

    private resolveAvatar(name: string = "default"): string {
      return expect(plan.avatars?.[name], `avatar ${name}`);
    }

    private resolveTag(tag: string): string | undefined {
      this.debug("🔖 Resolve tag", { tag });
      return this.#roomByTag.get(tag);
    }

    private scheduleReconcile(at: DateTime) {
      const delay = at.diffNow("milliseconds").valueOf();
      if (delay > maxDelay) throw new Error(`Not implemented for delay ${delay}`);

      if (this.#scheduledReconcile) {
        this.debug("🕓 Unschedule reconcile", {
          at: this.#scheduledReconcile.at.toISO(),
        });
        clearTimeout(this.#scheduledReconcile.timer);
        this.#scheduledReconcile = undefined;
      }

      this.debug("🕓 Schedule reconcile", { at: at.toISO() });
      const task = () => {
        this.#scheduledReconcile = undefined;

        this.debug("🕓 Run scheduled reconcile");
        this.reconcile(at);
      };
      this.#scheduledReconcile = { at, timer: setTimeout(task, delay) };
    }

    private scheduleRegroup(room: Room, session: Session, at: DateTime) {
      if (!this.#scheduledReconcile)
        throw new Error("Next reconciliation time is unknown");
      if (this.#scheduledReconcile.at <= at) return;

      const delay = at.diffNow("milliseconds").valueOf();
      if (delay > maxDelay) throw new Error(`Not implemented for delay ${delay}`);

      const existing = this.#scheduledRegroups.get(room.id);
      if (existing) {
        this.debug("🕓 Unschedule regroup", {
          room: room.local,
          at: existing.at.toISO(),
        });
        clearTimeout(existing.timer);
        this.#scheduledRegroups.delete(room.id);
      }

      this.debug("🕓 Schedule regroup", { room: room.local, at: at.toISO() });
      const task = () => {
        this.#scheduledRegroups.delete(room.id);

        this.debug("🕓 Run scheduled regroup", { room: room.local, at: at.toISO() });
        this.reconcileSessionGroups(room, session, at);
      };
      this.#scheduledRegroups.set(room.id, { at, timer: setTimeout(task, delay) });
    }

    private async tryInvite(room: string, user: string) {
      try {
        await this.matrix.inviteUser(user, room);
      } catch (error) {
        this.error("🔑 Failed to send invitation", { room, user, error });
      }
    }
  };
