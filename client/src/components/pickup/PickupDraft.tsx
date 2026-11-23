/**
 * The captain draft: a banner saying whose pick it is, and the players left to
 * pick, with a button on each for the captain whose turn it is.
 */
import React from 'react';
import { Avatar, Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Panel } from '../common/ui';
import type { PickupCommand, PickupLobby } from './pickupApi';

interface PickupDraftProps {
  lobby: PickupLobby;
  busy: boolean;
  onCommand: (command: PickupCommand) => void;
  /** Called when the pick's time is up, so the page reads the lobby again. */
  onDeadline: () => void;
}

function useSecondsLeft(deadline: number | null, onDeadline: () => void): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (deadline === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  const left = deadline === null ? 0 : Math.max(0, Math.ceil(deadline - now / 1000));
  const over = deadline !== null && left === 0;
  React.useEffect(() => {
    if (!over) return undefined;
    const timer = window.setTimeout(onDeadline, 1500);
    return () => window.clearTimeout(timer);
  }, [over, onDeadline, deadline]);
  return left;
}

export function PickupDraftBanner({ lobby, onDeadline }: PickupDraftProps) {
  const { t } = useTranslation();
  const left = useSecondsLeft(lobby.draft ? lobby.deadline : null, onDeadline);
  if (!lobby.draft) return null;
  const { captains, turn } = lobby.draft;
  const everyone = [...lobby.teams.a, ...lobby.teams.b, ...lobby.waiting];
  const nameOf = (id: string) => everyone.find((p) => p.playerId === id)?.name ?? '';
  return (
    <Panel
      sx={{ p: 2, mb: 2, borderColor: lobby.can.pick ? 'primary.main' : undefined }}
      data-testid="pickup-draft-banner"
    >
      <Typography variant="h6" component="h2">
        {lobby.can.pick && t('pickup.draft.yourPick')}
        {!lobby.can.pick && turn && t('pickup.draft.picking', { captain: nameOf(captains[turn]) })}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t('pickup.draft.captains', {
          a: nameOf(captains.a),
          b: nameOf(captains.b),
          seconds: left,
        })}
      </Typography>
    </Panel>
  );
}

export function PickupDraftPool({ lobby, busy, onCommand }: PickupDraftProps) {
  const { t } = useTranslation();
  if (!lobby.draft) return null;
  return (
    <Panel sx={{ p: 2 }} data-testid="pickup-draft-pool">
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        {t('pickup.draft.pool', { count: lobby.draft.pool.length })}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {lobby.draft.pool.map((player) => (
          <Box
            key={player.playerId}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 1,
              py: 0.5,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
            }}
          >
            <Avatar src={player.avatarUrl ?? undefined} sx={{ width: 24, height: 24 }} />
            <Typography sx={{ fontWeight: 600 }}>{player.name}</Typography>
            {player.rating !== null && (
              <Typography variant="body2" color="text.secondary">
                {player.rating}
              </Typography>
            )}
            {lobby.can.pick && (
              <Button
                size="small"
                variant="contained"
                disabled={busy}
                data-testid={`pickup-pick-${player.playerId}`}
                onClick={() => onCommand({ type: 'pick', playerId: player.playerId })}
              >
                {t('pickup.draft.pick')}
              </Button>
            )}
          </Box>
        ))}
      </Box>
    </Panel>
  );
}
