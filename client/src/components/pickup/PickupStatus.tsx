/** What the lobby is doing now: the ready check with its countdown, or the running match. */
import React from 'react';
import { Box, Button, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Panel } from '../common/ui';
import { matchDetailsPath } from '../../paths';
import type { PickupCommand, PickupLobby } from './pickupApi';
import { usePickupHost } from './pickupHost';

interface PickupStatusProps {
  lobby: PickupLobby;
  busy: boolean;
  onCommand: (command: PickupCommand) => void;
  /** Called when the ready check's time is up, so the page reads the lobby again. */
  onDeadline: () => void;
}

const MATCH_STATUSES = new Set(['pending', 'ready', 'loaded', 'live', 'completed']);

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
  }, [over, onDeadline]);
  return left;
}

export function PickupStatus({ lobby, busy, onCommand, onDeadline }: PickupStatusProps) {
  const { t } = useTranslation();
  const host = usePickupHost();
  const timed = lobby.state === 'ready_check' || lobby.state === 'map_vote';
  const left = useSecondsLeft(timed ? lobby.deadline : null, onDeadline);

  if (lobby.state === 'ready_check') {
    const seated = [...lobby.teams.a, ...lobby.teams.b];
    return (
      <Panel sx={{ p: 2, mb: 2 }} data-testid="pickup-ready-check">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h6" component="h2">
              {t('pickup.ready.title')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('pickup.ready.progress', {
                ready: seated.filter((p) => p.ready).length,
                total: seated.length,
                seconds: left,
              })}
            </Typography>
          </Box>
          {lobby.can.ready && (
            <Button
              variant="contained"
              color="success"
              disabled={busy}
              data-testid="pickup-ready"
              onClick={() => onCommand({ type: 'ready' })}
            >
              {t('pickup.ready.button')}
            </Button>
          )}
        </Box>
      </Panel>
    );
  }

  if (lobby.state === 'map_vote' && lobby.vote) {
    const { vote } = lobby;
    return (
      <Panel sx={{ p: 2, mb: 2 }} data-testid="pickup-map-vote">
        <Typography variant="h6" component="h2">
          {t('pickup.vote.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {t('pickup.vote.progress', { voted: vote.voted, total: vote.voters, seconds: left })}
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {lobby.maps.map((map) => (
            <Button
              key={map.id}
              variant={vote.mine === map.id ? 'contained' : 'outlined'}
              disabled={busy || !lobby.can.vote_map}
              data-testid={`pickup-vote-${map.id}`}
              onClick={() => onCommand({ type: 'vote_map', map: map.id })}
            >
              {map.name}
              {vote.counts[map.id] ? ` · ${vote.counts[map.id]}` : ''}
            </Button>
          ))}
        </Box>
      </Panel>
    );
  }

  if (lobby.state === 'in_match' && lobby.match) {
    const { match } = lobby;
    const status = MATCH_STATUSES.has(match.status) ? match.status : 'pending';
    const mapName = lobby.maps.find((map) => map.id === match.map)?.name ?? match.map;
    return (
      <Panel sx={{ p: 2, mb: 2 }} data-testid="pickup-match">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h6" component="h2">
              {t('pickup.match.title', { number: match.matchNo })}
              {mapName ? ` · ${mapName}` : ''}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {match.vetoing ? t('pickup.match.vetoing') : t(`pickup.match.status.${status}`)}
            </Typography>
          </Box>
          <Button
            variant="contained"
            data-testid="pickup-open-match"
            {...(host.openOutside
              ? { onClick: () => host.openOutside?.(matchDetailsPath(match.slug)) }
              : { component: RouterLink, to: matchDetailsPath(match.slug) })}
          >
            {lobby.me === 'a' || lobby.me === 'b'
              ? t('pickup.match.openPlayer')
              : t('pickup.match.open')}
          </Button>
        </Box>
      </Panel>
    );
  }

  return null;
}
