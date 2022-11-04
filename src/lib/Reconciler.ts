import { dump } from "js-yaml";
import isEqual from "lodash.isequal";
import mergeWith from "lodash.mergewith";
import { DateTime, Duration } from "luxon";
import {
  MatrixProfileInfo,
  Permalinks,
  PowerLevelsEventContent as PowerLevels,
  Space,
  SpaceEntityMap as Children,
} from "matrix-bot-sdk";
import MarkdownIt from "markdown-it";
import { assert, Equals } from "tsafe";
import type Client from "./Client.js";
import type { RoomCreateOptions } from "./Client.js";
import {
  Event,
  IStateEvent,
  mergeWithMatrixState,
  moderatorLevel,
  orNone,
  resolvePreset,
  StateEvent,
  StateEventInput,
} from "./matrix.js";
import { getOsemEvents, OsemEvent } from "./Osem.js";
import type { Plan, RoomPlan, RoomsPlan, SessionGroupId, SessionsPlan } from "./Plan.js";
import type { Scheduled } from "./scheduling.js";
import { expect, logger, maxDelay, unimplemented } from "./utilities.js";

const { debug, error, info } = logger("Reconciler");
const md = new MarkdownIt();

interface Room extends RoomPlan {
  id: string;
  local: string;
  order: string;
}

interface ListedSpace extends Space {
  children: Children;
  local: string;
}

interface Session extends OsemEvent {
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

const compareAliases = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: "base" });
const compareSessions = (a: Session, b: Session): number =>
  a.beginning !== b.beginning
    ? a.beginning.valueOf() - b.beginning.valueOf()
    : a.end !== b.end
    ? a.end.valueOf() - b.end.valueOf()
    : a.title.localeCompare(b.title);
const sortKey = (index: number): string => String(10 * (1 + index)).padStart(4, "0");

export default class Reconciler {
  #privateChildrenByParent: Map<string, Set<string>>;
  #protectedRooms: Set<string>;
  #roomByTag: Map<string, string>;
  #scheduledReconcile: Scheduled | undefined;
  #scheduledRegroups: Map<Room["id"], Scheduled>;
  #sessionGroups: { [id in SessionGroupId]?: ListedSpace };
  #spaceByChild: Map<string, string>;

  public constructor(private readonly matrix: Client, private readonly plan: Plan) {
    this.#privateChildrenByParent = new Map();
    this.#protectedRooms = new Set();
    this.#roomByTag = new Map();
    this.#scheduledRegroups = new Map();
    this.#sessionGroups = {};
    this.#spaceByChild = new Map();
  }

  public getParent(child: string): string | undefined {
    return this.#spaceByChild.get(child);
  }

  public async start() {
    for (const room of await this.matrix.getJoinedRooms()) {
      const tag = await this.getTag(room);
      if (tag) this.#roomByTag.set(tag, room);
    }

    await this.reconcile();

    this.matrix.on("room.event", this.handleRoomEvent.bind(this));

    console.log(
      dump({
        protectedRooms: [...this.#protectedRooms]
          .sort(compareAliases)
          .map((local) => Permalinks.forRoom(this.localToAlias(local))),
      })
    );
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
                join_rule: "restricted" /* knock_restricted pending room version 10 */,
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
  ): Promise<Event<"m.room.message"> | undefined> {
    debug("🪧 Get notice", { room, id });
    return await this.matrix.getEvent(room, id).catch(orNone);
  }

  private getPowerLevels({ readOnly, redirect, widget }: RoomPlan): PowerLevels {
    return {
      ...this.plan.powerLevels,
      events: {
        ...this.plan.powerLevels.events,
        ...(widget
          ? { "im.vector.modular.widgets": 99, "io.element.widgets.layout": 99 }
          : {}),
      },
      ...(readOnly || redirect ? { events_default: moderatorLevel } : {}),
    };
  }

  private async getRootMessage(room: string, id: string): Promise<string> {
    debug("💬 Get message", { room, id });
    const message: Event<"m.room.message"> | undefined = await this.matrix
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

    debug("🔖 Tag", { room, tag });
    return tag;
  }

  private async handleMembership(
    room: string,
    { state_key: user, content: { membership } }: StateEvent<"m.room.member">
  ) {
    debug("🚪 Membership", { room, user, membership });

    if (
      membership === "join" &&
      this.#privateChildrenByParent.has(room) &&
      (await this.getModerators(room)).includes(user)
    ) {
      for (const child of this.#privateChildrenByParent.get(room) ?? []) {
        const memberships = await this.matrix.getRoomMembers(child);

        if (!memberships.some((m) => m.membershipFor === user)) {
          info("🔑 Invite space moderator to private room", {
            space: room,
            moderator: user,
            room: child,
          });
          await this.tryInvite(child, user);
        }
      }
    }
  }

  private handleRoomEvent(room: string, event: Event) {
    if (event.type === "m.room.member") this.handleMembership(room, event);
  }

  private async listSpace(space: Space, local: string): Promise<ListedSpace> {
    debug("🏘️ List space", { local });
    return Object.assign(space, { children: await space.getChildEntities(), local });
  }

  private localToAlias(local: string): string {
    return local.startsWith("SeaGL2022")
      ? `#${local.replace(/^SeaGL/, "")}:seagl.org`
      : `#${local}:${this.plan.homeserver}`;
  }

  private async reconcileAlias(room: Room, expected: string) {
    if (expected.endsWith(this.plan.homeserver)) {
      const resolved = await this.resolveAlias(expected);

      if (resolved && resolved !== room.id) {
        info("🏷️ Reassign alias", { alias: expected, from: resolved, to: room.id });
        await this.matrix.deleteRoomAlias(expected);
        await this.matrix.createRoomAlias(expected, room.id);
      } else if (!resolved) {
        info("🏷️ Create alias", { alias: expected, room: room.local });
        await this.matrix.createRoomAlias(expected, room.id);
      }
    }

    const content = await this.matrix
      .getRoomStateEvent<StateEvent<"m.room.canonical_alias">>(
        room.id,
        "m.room.canonical_alias"
      )
      .catch(orNone);
    const actual = content?.alias;

    if (actual !== expected) {
      info("🏷️ Update canonical alias", { room: room.local, from: actual, to: expected });
      this.reconcileState(room, {
        type: "m.room.canonical_alias",
        content: { ...content, alias: expected },
      });
    }
  }

  private async reconcile(now = DateTime.local({ zone: this.plan.timeZone })) {
    this.scheduleReconcile(now.plus(reconcilePeriod));

    info("🔃 Reconcile");
    await this.reconcileProfile(this.plan.steward);
    await this.reconcileRooms(this.plan.rooms);
    if (this.plan.sessions) await this.reconcileSessions(this.plan.sessions, now);
    debug("🔃 Completed reconciliation");
  }

  private async reconcileAvatar(room: Room) {
    const content = { url: this.resolveAvatar(room.avatar) };
    await this.reconcileState(room, { type: "m.room.avatar", content });
  }

  private async reconcileChildhood(space: ListedSpace, room: Room, include = true) {
    const { id, local: child, order, suggested = false } = room;
    const actual = space.children[id]?.content;
    if (!include) return actual && (await this.removeFromSpace(space, id, child));

    const expected = { order, suggested };

    if (actual) {
      let changed = false;
      mergeWith(actual, expected, (from, to, option) => {
        if (typeof to === "object" || !(from || to) || from === to) return;

        info("🏘️ Update childhood", { space: space.local, child, option, from, to });
        changed = true;
      });

      if (changed) {
        debug("🏘️ Set childhood", { space: space.local, child });
        await space.addChildRoom(id, actual);
      }
    } else {
      info("🏘️ Add to space", { space: space.local, child });
      await space.addChildRoom(id, { via: [this.plan.homeserver], ...expected });
    }
    this.#spaceByChild.set(id, space.roomId);
    const privateChildren = this.#privateChildrenByParent.get(space.roomId) ?? new Set();
    privateChildren[room.private ? "add" : "delete"](id);
    this.#privateChildrenByParent.set(space.roomId, privateChildren);
  }

  private async reconcileChildren(space: ListedSpace, expected: Room[]) {
    const actual = Object.keys(space.children);
    const ids = new Set(expected.map((r) => r.id));

    for (const a of actual) if (!ids.has(a)) await this.removeFromSpace(space, a);
    for (const room of expected) await this.reconcileChildhood(space, room);
  }

  private async reconcileExistence(
    local: string,
    expected: RoomPlan,
    parent?: Room
  ): Promise<[string | undefined, boolean]> {
    const alias = this.localToAlias(local);

    const existingByTag = expected.tag && this.resolveTag(expected.tag);
    const existingByAlias = await this.resolveAlias(alias);
    if (existingByTag && existingByAlias && existingByAlias !== existingByTag) {
      info("🏷️ Delete alias", { alias });
      await this.matrix.deleteRoomAlias(alias);
    }
    const existing = existingByTag ?? existingByAlias;

    if (expected.destroy) {
      if (existing) {
        info("🏷️ Delete alias", { alias });
        await this.matrix.deleteRoomAlias(alias);

        const reason = "Decommissioning room";
        const members = await this.matrix.getJoinedRoomMembers(existing);
        for (const user of members) {
          if (user === this.plan.steward.id) continue;

          info("🚪 Kick user", { room: existing, user, reason });
          await this.matrix.kickUser(user, existing, reason);
        }

        info("🚪 Leave room", { room: existing });
        await this.matrix.leaveRoom(existing);

        debug("📇 Forget room", { room: existing });
        await this.matrix.forgetRoom(existing);
      }

      return [undefined, false];
    } else {
      if (existing) return [existing, false];

      info("🏠 Create room", { local });
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
            room_version: this.plan.defaultRoomVersion,
            room_alias_name: local,
            name: expected.name,
            power_level_content_override: this.getPowerLevels(expected),
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
    const message = await this.reconcileNotice(room, event?.message, body, redactReason);

    await this.reconcileState(room, { type, content: message ? { message } : {} });
  }

  private async reconcileInvitations(child: Room, parent?: Room) {
    if (!(parent && child.private)) return;

    debug("🛡️ List moderators", { space: parent.local });
    const moderators = await this.getModerators(parent.id);

    debug("🚪 Get memberships", { space: parent.local });
    const parentMemberships = await this.matrix.getRoomMembers(parent.id);

    debug("🚪 Get memberships", { room: child.local });
    const childMemberships = await this.matrix.getRoomMembers(child.id);

    for (const { membership, membershipFor: recipient, sender } of childMemberships) {
      if (
        membership === "invite" &&
        sender === this.plan.steward.id &&
        !moderators.includes(recipient)
      ) {
        info("🔑 Withdraw invitation", { room: child.local, recipient });
        await this.matrix.sendStateEvent(child.id, "m.room.member", recipient, {
          membership: "leave",
        });
      }
    }

    for (const moderator of moderators) {
      if (
        parentMemberships.some(
          (m) => m.membershipFor === moderator && m.membership === "join"
        ) &&
        !childMemberships.some((m) => m.membershipFor === moderator)
      ) {
        info("🔑 Invite space moderator to private room", {
          space: parent.local,
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
      info("🪧 Notice", { room, body: expected });
      let content: Event<"m.room.message">["content"];
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

  private async reconcilePowerLevels(room: Room) {
    const expected = this.getPowerLevels(room);

    debug("🛡️ Get power levels", { room: room.local });
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

      info("🛡️ Update power level", { room: room.local, ability, from, to });
      changed = true;
    });

    if (changed) {
      debug("🛡️ Set power levels", { room: room.local, content: actual });
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
      for (const event of expected.initial_state) await this.reconcileState(room, event);
  }

  private async reconcileProfile({ avatar, name }: Plan["steward"]) {
    const user = this.plan.steward.id;

    debug("👤 Get profile", { user });
    const actual: MatrixProfileInfo = await this.matrix.getUserProfile(user);

    if (!(actual.displayname === name)) {
      info("👤 Set display name", { user, from: actual.displayname, to: name });
      await this.matrix.setDisplayName(name);
    }

    const url = this.resolveAvatar(avatar);
    if (!(actual.avatar_url === url)) {
      info("👤 Set avatar", { user, from: actual.avatar_url, to: url });
      await this.matrix.setAvatarUrl(url);
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
    const message = await this.reconcileNotice(room, event?.message, body, redactReason);

    await this.reconcileState(room, { type, content: message ? { message } : {} });
  }

  private async reconcileRoom(
    local: string,
    order: string,
    expected: RoomPlan,
    parent?: Room
  ): Promise<Room | undefined> {
    const [id, created] = await this.reconcileExistence(local, expected, parent);

    this.#protectedRooms[id && !expected.private ? "add" : "delete"](local);

    if (!id) {
      if (typeof expected.children === "object")
        await this.reconcileRooms(expected.children);

      return undefined;
    }

    const room = { ...expected, id, local, order };

    if (!created) {
      await this.reconcileTag(room);
      await this.reconcileAlias(room, this.localToAlias(local));
      await this.reconcilePowerLevels(room);
      await this.reconcilePrivacy(room, parent);
      await this.reconcileAvatar(room);
      await this.reconcileName(room);
      await this.reconcileTopic(room);
    }

    await this.reconcileWidget(room);
    await this.reconcileRedirect(room);
    await this.reconcileIntro(room);

    if (expected.children) {
      debug("🏘️ Get space", { local });
      const space = await this.matrix.getSpace(id);

      if (typeof expected.children === "string") {
        this.#sessionGroups[expected.children] = await this.listSpace(space, local);
      } else {
        await this.reconcileChildren(
          await this.listSpace(space, local),
          await this.reconcileRooms(expected.children, room)
        );
      }
    }

    await this.reconcileInvitations(room, parent);

    return room;
  }

  private async reconcileRooms(expected: RoomsPlan, parent?: Room): Promise<Room[]> {
    const rooms = [];

    for (const [index, [local, plan]] of Object.entries(expected).entries()) {
      const order = sortKey(index);
      const room = await this.reconcileRoom(local, order, plan, parent);

      if (room) rooms.push(room);
    }

    return rooms;
  }

  private async reconcileSessions(plan: SessionsPlan, now: DateTime) {
    const ignore = new Set(plan.ignore ?? []);

    debug("📅 Get sessions", { conference: plan.conference });
    const osemEvents = await getOsemEvents(plan.conference);
    const startOfDay = DateTime.min(...osemEvents.map((e) => e.beginning)).startOf("day");
    const sessions = osemEvents
      .filter((e) => !ignore.has(e.id))
      .map((event) => ({
        ...event,
        day: event.beginning.startOf("day").diff(startOfDay, "days").days,
        open: event.beginning.minus({ minutes: plan.openEarly }),
      }));
    sessions.sort(compareSessions);
    if (plan.demo) {
      const dt = DateTime.fromISO(plan.demo, { zone: this.plan.timeZone });
      const offset = now.startOf("day").diff(dt, "days");
      info("📅 Override conference date", { from: dt.toISODate(), to: now.toISODate() });
      for (const session of sessions) {
        const to = session.beginning.plus(offset);
        debug("📅 Override session time", {
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
      const suffix = plan.suffixes?.[session.id] ?? `session-${session.id}`;
      const redirect = plan.redirects?.[session.id];
      const widget = plan.widgets?.[session.room]?.[session.day];

      const room = await this.reconcileRoom(`${plan.prefix}${suffix}`, sortKey(index), {
        name: `${session.beginning.toFormat("EEE HH:mm")} ${session.title}`,
        tag: `osem-event-${session.id}`,
        topic: `Details: ${session.url}`,
        ...(redirect ? { redirect } : {}),
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
    { id, local: room }: Room,
    expected: StateEventInput
  ): Promise<boolean> {
    const { type, state_key: key, content: to } = expected;
    debug("🗄️ Get state", { room, type, key });
    const from = await this.matrix.getRoomStateEvent(id, type, key).catch(orNone);

    if (
      (Object.keys(from ?? {}).length > 0 || Object.keys(to).length > 0) &&
      !isEqual(from, to)
    ) {
      info("🗄️ Set state", { room, type, key, from, to });
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
            creatorUserId: this.plan.steward.id,
            name: room.widget.name ?? room.name,
            ...("custom" in room.widget
              ? { type: "customwidget", url: room.widget.custom }
              : "jitsi" in room.widget
              ? {
                  type: "jitsi",
                  url: jitsiUrl,
                  data: {
                    domain: this.plan.jitsiDomain,
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

  private async redactNotice(room: string, id: string, reason: string): Promise<string> {
    const root = await this.getRootMessage(room, id);

    info("🪧 Redact notice", { room, id, root, reason });
    return await this.matrix.redactEvent(room, root, reason);
  }

  private async removeFromSpace(space: ListedSpace, id: string, local?: string) {
    info("🏘️ Remove from space", { space: space.local, child: local ?? id });
    await space.removeChildRoom(id);
    this.#spaceByChild.delete(id);
    const privateChildren = this.#privateChildrenByParent.get(space.roomId);
    if (privateChildren)
      if (privateChildren.delete(id))
        this.#privateChildrenByParent.set(space.roomId, privateChildren);
  }

  private async replaceNotice(
    room: string,
    id: string,
    body: { html?: string; text: string }
  ): Promise<string> {
    const root = await this.getRootMessage(room, id);

    info("🪧 Replace notice", { room, id, root, body });
    let content: Event<"m.room.message">["content"];
    if (body.html) {
      content = {
        msgtype: "m.notice",
        body: body.text,
        format: "org.matrix.custom.html",
        formatted_body: body.html,
      };
    } else {
      content = {
        msgtype: "m.notice",
        body: body.text,
      };
    }
    return await this.matrix.sendMessage(room, {
      ...content,
      "m.relates_to": { rel_type: "m.replace", event_id: root },
      "m.new_content": content,
    });
  }

  private async resolveAlias(alias: string): Promise<string | undefined> {
    debug("🏷️ Resolve alias", { alias });
    return (await this.matrix.lookupRoomAlias(alias).catch(orNone))?.roomId;
  }

  private resolveAvatar(name: string = "default"): string {
    return expect(this.plan.avatars[name], `avatar ${name}`);
  }

  private resolveTag(tag: string): string | undefined {
    debug("🔖 Resolve tag", { tag });
    return this.#roomByTag.get(tag);
  }

  private scheduleReconcile(at: DateTime) {
    const delay = at.diffNow("milliseconds").valueOf();
    if (delay > maxDelay) throw new Error(`Not implemented for delay ${delay}`);

    if (this.#scheduledReconcile) {
      debug("🕓 Unschedule reconcile", { at: this.#scheduledReconcile.at.toISO() });
      clearTimeout(this.#scheduledReconcile.timer);
      this.#scheduledReconcile = undefined;
    }

    debug("🕓 Schedule reconcile", { at: at.toISO() });
    const task = () => {
      this.#scheduledReconcile = undefined;

      debug("🕓 Run scheduled reconcile");
      this.reconcile(at);
    };
    this.#scheduledReconcile = { at, timer: setTimeout(task, delay) };
  }

  private scheduleRegroup(room: Room, session: Session, at: DateTime) {
    if (!this.#scheduledReconcile) throw new Error("Next reconciliation time is unknown");
    if (this.#scheduledReconcile.at <= at) return;

    const delay = at.diffNow("milliseconds").valueOf();
    if (delay > maxDelay) throw new Error(`Not implemented for delay ${delay}`);

    const existing = this.#scheduledRegroups.get(room.id);
    if (existing) {
      debug("🕓 Unschedule regroup", { room: room.local, at: existing.at.toISO() });
      clearTimeout(existing.timer);
      this.#scheduledRegroups.delete(room.id);
    }

    debug("🕓 Schedule regroup", { room: room.local, at: at.toISO() });
    const task = () => {
      this.#scheduledRegroups.delete(room.id);

      debug("🕓 Run scheduled regroup", { room: room.local, at: at.toISO() });
      this.reconcileSessionGroups(room, session, at);
    };
    this.#scheduledRegroups.set(room.id, { at, timer: setTimeout(task, delay) });
  }

  private async tryInvite(room: string, user: string) {
    try {
      await this.matrix.inviteUser(user, room);
    } catch (response) {
      error("🔑 Failed to send invitation", { room, user, response });
    }
  }
}
