/** One side of a pickup lobby, or its waiting room: the players and each row's actions. */
import { Avatar, Box, Button, Chip, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Panel } from '../common/ui';
import { playerProfilePath } from '../../paths';
import type { PickupCommand, PickupLobby, PickupPlayer, Side } from './pickupApi';

interface PickupTeamPanelProps {
  lobby: PickupLobby;
  /** The side shown; null for the waiting room. */
  side: Side | null;
  viewerId: string | null;
  busy: boolean;
  onCommand: (command: PickupCommand) => void;
}

const OTHER: Record<Side, Side> = { a: 'b', b: 'a' };

function averageRating(players: PickupPlayer[]): number | null {
  const rated = players.flatMap((p) => (p.rating === null ? [] : [p.rating]));
  if (rated.length === 0) return null;
  return Math.round(rated.reduce((sum, r) => sum + r, 0) / rated.length);
}

export function PickupTeamPanel({ lobby, side, viewerId, busy, onCommand }: PickupTeamPanelProps) {
  const { t } = useTranslation();
  const players = side === null ? lobby.waiting : lobby.teams[side];
  const teamSize = lobby.settings.teamSize;
  const where = side ?? 'waiting';
  const title = side === null ? t('pickup.waitingRoom') : t(`pickup.team.${side}`);
  const count = side === null ? String(players.length) : `${players.length}/${teamSize}`;
  const average = averageRating(players);
  const full = side !== null && players.length >= teamSize;
  const canJoin = lobby.can.join && lobby.me !== where && !full;
  const emptySeats = side === null ? 0 : Math.max(0, teamSize - players.length);
  const roomOn = (target: Side) => lobby.teams[target].length < teamSize;

  return (
    <Panel sx={{ p: 2 }} data-testid={`pickup-${where}`}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1.5 }}>
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {count}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {side !== null && average !== null && (
          <Typography variant="body2" color="text.secondary">
            {t('pickup.averageRating', { rating: average })}
          </Typography>
        )}
      </Box>

      {players.map((player) => (
        <Box
          key={player.playerId}
          data-testid={`pickup-player-${player.playerId}`}
          sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.75, flexWrap: 'wrap' }}
        >
          <Avatar src={player.avatarUrl ?? undefined} sx={{ width: 28, height: 28 }} />
          <Typography
            component={RouterLink}
            to={playerProfilePath(player.playerId)}
            sx={{ color: 'inherit', textDecoration: 'none', fontWeight: 600 }}
          >
            {player.name}
          </Typography>
          {player.isHost && <Chip size="small" label={t('pickup.host')} />}
          {player.rating !== null && (
            <Typography variant="body2" color="text.secondary">
              {player.rating}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {lobby.can.move && side !== null && roomOn(OTHER[side]) && (
            <Button
              size="small"
              disabled={busy}
              onClick={() =>
                onCommand({ type: 'move', playerId: player.playerId, side: OTHER[side] })
              }
            >
              {t('pickup.row.swap')}
            </Button>
          )}
          {lobby.can.move && side !== null && (
            <Button
              size="small"
              disabled={busy}
              onClick={() => onCommand({ type: 'move', playerId: player.playerId, side: null })}
            >
              {t('pickup.row.toWaiting')}
            </Button>
          )}
          {lobby.can.move &&
            side === null &&
            (['a', 'b'] as const).filter(roomOn).map((target) => (
              <Button
                key={target}
                size="small"
                disabled={busy}
                onClick={() => onCommand({ type: 'move', playerId: player.playerId, side: target })}
              >
                {t(`pickup.row.seat.${target}`)}
              </Button>
            ))}
          {lobby.can.make_host && !player.isHost && (
            <Button
              size="small"
              disabled={busy}
              onClick={() => onCommand({ type: 'make_host', playerId: player.playerId })}
            >
              {t('pickup.row.makeHost')}
            </Button>
          )}
          {lobby.can.kick && player.playerId !== viewerId && (
            <Button
              size="small"
              color="error"
              disabled={busy}
              onClick={() => onCommand({ type: 'kick', playerId: player.playerId })}
            >
              {t('pickup.row.kick')}
            </Button>
          )}
        </Box>
      ))}

      {Array.from({ length: emptySeats }, (_, i) => (
        <Typography key={i} variant="body2" color="text.secondary" sx={{ py: 0.75 }}>
          {t('pickup.emptySeat')}
        </Typography>
      ))}
      {side === null && players.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {t('pickup.waitingEmpty')}
        </Typography>
      )}

      {canJoin && (
        <Button
          variant="outlined"
          fullWidth
          sx={{ mt: 1.5 }}
          disabled={busy}
          data-testid={`pickup-join-${where}`}
          onClick={() => onCommand({ type: 'join', side })}
        >
          {side === null ? t('pickup.joinWaiting') : t(`pickup.join.${side}`)}
        </Button>
      )}
    </Panel>
  );
}
