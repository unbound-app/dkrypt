import { REST } from '@discordjs/rest';
import { Routes, type APIGuild, type APIGuildMember, type APIRole } from 'discord-api-types/v10';
import { config, discordBotEnabled } from './config.js';
import { scopedLogger } from './logger.js';

const log = scopedLogger('discord');

let rest: REST | undefined;

function client(): REST {
  rest ??= new REST({ version: '10' }).setToken(config.discordBotToken);
  return rest;
}

function statusOf(err: unknown): number | undefined {
  return err instanceof Error && 'status' in err ? (err as { status: number }).status : undefined;
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
}

// Guilds the bot itself is a member of - lets an admin pick the target guild from a dropdown in
// Settings instead of hand-copying an id into an env var.
export async function fetchBotGuilds(): Promise<DiscordGuildSummary[]> {
  if (!discordBotEnabled) return [];
  try {
    const guilds = (await client().get(Routes.userGuilds())) as APIGuild[];
    return guilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon ?? null }));
  } catch (err) {
    log.warn('failed to fetch bot guilds', { error: String(err) });
    return [];
  }
}

export interface DiscordGuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

export async function fetchGuildRoles(guildId: string): Promise<DiscordGuildRole[]> {
  if (!discordBotEnabled) return [];
  try {
    const roles = (await client().get(Routes.guildRoles(guildId))) as APIRole[];
    return roles
      .filter((r) => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position }));
  } catch (err) {
    log.warn('failed to fetch guild roles', { guildId, error: String(err) });
    return [];
  }
}

// undefined means "couldn't determine" (not a member, guild/bot misconfigured, API error) - the
// caller should leave existing perk-granted roles untouched rather than treat it as "holds none".
export async function fetchMemberRoleIds(guildId: string, discordUserId: string): Promise<string[] | undefined> {
  if (!discordBotEnabled) return undefined;
  try {
    const member = (await client().get(Routes.guildMember(guildId, discordUserId))) as APIGuildMember;
    return member.roles;
  } catch (err) {
    if (statusOf(err) === 404) return [];
    log.warn('failed to fetch guild member', { guildId, error: String(err) });
    return undefined;
  }
}
