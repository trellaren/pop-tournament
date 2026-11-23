/** Who the pickup moderators are, for site admins. */
import React from 'react';
import { Box, Button, Chip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Panel } from '../../common/ui';
import { PlayerPicker, type PickedPlayer } from '../../common/PlayerPicker';
import type { PickupNamed } from './moderationApi';

interface ModeratorsCardProps {
  moderators: PickupNamed[];
  busy: boolean;
  onSet: (playerId: string, on: boolean) => void;
}

export function ModeratorsCard({ moderators, busy, onSet }: ModeratorsCardProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = React.useState<PickedPlayer | null>(null);

  return (
    <Panel sx={{ p: 2, mb: 2 }} data-testid="pickup-mod-moderators">
      <Typography variant="h6" sx={{ mb: 0.5 }}>
        {t('pickup.moderation.moderators')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {t('pickup.moderation.moderatorsHint')}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
        <Box sx={{ flex: '1 1 14rem', minWidth: '12rem' }}>
          <PlayerPicker
            label={t('pickup.moderation.player')}
            value={picked}
            onChange={setPicked}
            exclude={moderators.map((m) => m.playerId)}
            testId="pickup-mod-moderator-player"
          />
        </Box>
        <Button
          variant="contained"
          disabled={busy || !picked}
          data-testid="pickup-mod-moderator-add"
          onClick={() => {
            if (!picked) return;
            onSet(picked.steamid64, true);
            setPicked(null);
          }}
        >
          {t('pickup.moderation.addModerator')}
        </Button>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {moderators.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t('pickup.moderation.noModerators')}
          </Typography>
        )}
        {moderators.map((moderator) => (
          <Chip
            key={moderator.playerId}
            label={moderator.name}
            data-testid={`pickup-mod-moderator-${moderator.playerId}`}
            disabled={busy}
            onDelete={() => onSet(moderator.playerId, false)}
          />
        ))}
      </Box>
    </Panel>
  );
}
