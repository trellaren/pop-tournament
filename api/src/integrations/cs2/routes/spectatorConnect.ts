/**
 * How a listed spectator joins a pickup match's server
 * (GameIntegration.matchSpectatorConnect): the address and, on a Ready Up
 * server, this assignment's password. Core decides who is asked for; a match
 * that is over or has no server gives null. Never logged.
 */
import { db } from '../../../config/database';
import { connectPasswordFor } from '../fleet/driver';
import { connectIp } from './matchConnect';

export interface SpectatorConnect {
  host: string;
  ip: string | null;
  port: number;
  password: string | null;
}

export async function matchSpectatorConnect(slug: string): Promise<SpectatorConnect | null> {
  const row = await db.queryOneAsync<{
    status: string;
    host: string | null;
    port: number | null;
    transport: string | null;
  }>(
    `SELECT m.status, s.host, s.port, s.transport
       FROM matches m JOIN cs2_servers s ON m.server_id = s.id
      WHERE m.slug = ?`,
    [slug]
  );
  if (!row?.host || !row.port) return null;
  if (row.status === 'completed' || row.status === 'cancelled') return null;
  return {
    host: row.host,
    ip: await connectIp(row.host),
    port: Number(row.port),
    password: row.transport === 'fleet' ? await connectPasswordFor(slug) : null,
  };
}
