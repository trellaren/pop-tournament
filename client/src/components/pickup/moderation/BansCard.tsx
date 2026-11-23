/** Bans from pickup that hold now, with Lift, and a picker to ban someone. */
import React from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Panel } from '../../common/ui';
import { PlayerPicker, type PickedPlayer } from '../../common/PlayerPicker';
import { PickupBanDialog } from '../PickupBanDialog';
import type { PickupBan } from './moderationApi';

interface BansCardProps {
  bans: PickupBan[];
  busy: boolean;
  onLift: (playerId: string) => void;
  onChanged: () => void;
}

export function BansCard({ bans, busy, onLift, onChanged }: BansCardProps) {
  const { t, i18n } = useTranslation();
  const [picked, setPicked] = React.useState<PickedPlayer | null>(null);
  const [banning, setBanning] = React.useState<{ playerId: string; name: string } | null>(null);

  const until = (ban: PickupBan) =>
    ban.until === null
      ? t('pickup.moderation.untilLifted')
      : t('pickup.moderation.until', {
          when: new Date(ban.until * 1000).toLocaleString(i18n.language),
        });

  return (
    <Panel sx={{ p: 2, mb: 2 }} data-testid="pickup-mod-bans">
      <Typography variant="h6" sx={{ mb: 0.5 }}>
        {t('pickup.moderation.bans')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {t('pickup.moderation.bansHint')}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
        <Box sx={{ flex: '1 1 14rem', minWidth: '12rem' }}>
          <PlayerPicker
            label={t('pickup.moderation.player')}
            value={picked}
            onChange={setPicked}
            exclude={bans.map((ban) => ban.playerId)}
            testId="pickup-mod-ban-player"
          />
        </Box>
        <Button
          color="error"
          variant="contained"
          disabled={busy || !picked}
          data-testid="pickup-mod-ban"
          onClick={() => picked && setBanning({ playerId: picked.steamid64, name: picked.name })}
        >
          {t('pickup.row.ban')}
        </Button>
      </Box>
      {bans.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {t('pickup.moderation.noBans')}
        </Typography>
      )}
      {bans.map((ban) => (
        <Box
          key={ban.playerId}
          data-testid={`pickup-mod-banned-${ban.playerId}`}
          sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 0.75, flexWrap: 'wrap' }}
        >
          <Box sx={{ flex: 1, minWidth: '10rem' }}>
            <Typography sx={{ fontWeight: 600 }}>{ban.name}</Typography>
            <Typography variant="body2" color="text.secondary">
              {until(ban)}
              {ban.reason ? ` · ${ban.reason}` : ''}
            </Typography>
          </Box>
          <Button
            size="small"
            disabled={busy}
            data-testid={`pickup-mod-lift-${ban.playerId}`}
            onClick={() => onLift(ban.playerId)}
          >
            {t('pickup.moderation.lift')}
          </Button>
        </Box>
      ))}
      <PickupBanDialog
        player={banning}
        onClose={() => setBanning(null)}
        onBanned={() => {
          setBanning(null);
          setPicked(null);
          onChanged();
        }}
      />
    </Panel>
  );
}
