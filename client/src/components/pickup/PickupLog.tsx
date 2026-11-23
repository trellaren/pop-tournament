/** The lobby log: what happened, newest last, scrolling inside a fixed height. */
import React from 'react';
import { Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Panel } from '../common/ui';
import type { PickupLogLine } from './pickupApi';

const KNOWN = new Set([
  'opened',
  'joined',
  'moved',
  'left',
  'kicked',
  'host_changed',
  'scrambled',
  'balanced',
  'teams_locked',
  'teams_unlocked',
  'settings_changed',
  'closed',
]);

function placeKey(side: PickupLogLine['data'][string]): string {
  if (side === 'a' || side === 'b') return `pickup.team.${side}`;
  return 'pickup.waitingRoom';
}

export function PickupLog({ lines }: { lines: PickupLogLine[] }) {
  const { t } = useTranslation();
  const end = React.useRef<HTMLDivElement | null>(null);
  const newest = lines.length > 0 ? lines[lines.length - 1].id : 0;

  React.useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [newest]);

  return (
    <Panel sx={{ p: 2 }} data-testid="pickup-log">
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        {t('pickup.log.title')}
      </Typography>
      <Box sx={{ maxHeight: '15rem', overflowY: 'auto' }}>
        {lines
          .filter((line) => KNOWN.has(line.type))
          .map((line) => (
            <Typography key={line.id} variant="body2" color="text.secondary" sx={{ py: 0.25 }}>
              {new Date(line.at * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              {t(`pickup.log.${line.type}`, {
                actor: line.actorName,
                player: line.playerName ?? line.actorName,
                place: t(placeKey(line.data.side)),
                size: line.data.teamSize ?? '',
              })}
            </Typography>
          ))}
        <div ref={end} />
      </Box>
    </Panel>
  );
}
