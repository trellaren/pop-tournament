/**
 * Per player, for site admins: the balance multiplier and the display names.
 * Nothing shown to anyone else reveals the multiplier.
 */
import React from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Panel } from '../../common/ui';
import { PlayerPicker, type PickedPlayer } from '../../common/PlayerPicker';
import type { PickupPlayerSetting } from './moderationApi';

interface PlayersCardProps {
  players: PickupPlayerSetting[];
  busy: boolean;
  onSave: (playerId: string, change: { multiplier: number | null; displayNames: string[] }) => void;
}

const namesOf = (text: string) =>
  text
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

function PlayerRow({
  player,
  busy,
  onSave,
}: {
  player: PickupPlayerSetting;
  busy: boolean;
  onSave: PlayersCardProps['onSave'];
}) {
  const { t } = useTranslation();
  const [multiplier, setMultiplier] = React.useState(String(player.multiplier ?? 1));
  const [names, setNames] = React.useState(player.displayNames.join(', '));
  const value = Number(multiplier);
  const valid = Number.isFinite(value) && value >= 0.1 && value <= 1;

  return (
    <Box
      data-testid={`pickup-mod-player-${player.playerId}`}
      sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1, flexWrap: 'wrap' }}
    >
      <Typography sx={{ fontWeight: 600, flex: '1 1 8rem', minWidth: '8rem' }}>
        {player.name}
      </Typography>
      <TextField
        size="small"
        label={t('pickup.moderation.multiplier')}
        value={multiplier}
        error={!valid}
        onChange={(event) => setMultiplier(event.target.value)}
        sx={{ width: '7rem' }}
        slotProps={{ htmlInput: { inputMode: 'decimal', 'data-testid': 'pickup-mod-multiplier' } }}
      />
      <TextField
        size="small"
        label={t('pickup.moderation.displayNames')}
        value={names}
        onChange={(event) => setNames(event.target.value)}
        sx={{ flex: '2 1 14rem' }}
        slotProps={{ htmlInput: { 'data-testid': 'pickup-mod-names' } }}
      />
      <Button
        size="small"
        variant="contained"
        disabled={busy || !valid}
        data-testid="pickup-mod-player-save"
        onClick={() =>
          onSave(player.playerId, {
            multiplier: value === 1 ? null : value,
            displayNames: namesOf(names),
          })
        }
      >
        {t('pickup.moderation.save')}
      </Button>
      <Button
        size="small"
        disabled={busy}
        data-testid="pickup-mod-player-clear"
        onClick={() => onSave(player.playerId, { multiplier: null, displayNames: [] })}
      >
        {t('pickup.moderation.clear')}
      </Button>
    </Box>
  );
}

export function PlayersCard({ players, busy, onSave }: PlayersCardProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = React.useState<PickedPlayer | null>(null);
  const known = players.some((player) => player.playerId === picked?.steamid64);
  // Someone picked and not yet saved shows as a row with nothing set.
  const rows: PickupPlayerSetting[] =
    picked && !known
      ? [
          { playerId: picked.steamid64, name: picked.name, multiplier: null, displayNames: [] },
          ...players,
        ]
      : players;

  return (
    <Panel sx={{ p: 2, mb: 2 }} data-testid="pickup-mod-players">
      <Typography variant="h6" sx={{ mb: 0.5 }}>
        {t('pickup.moderation.players')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {t('pickup.moderation.playersHint')}
      </Typography>
      <Box sx={{ maxWidth: '24rem', mb: 1 }}>
        <PlayerPicker
          label={t('pickup.moderation.player')}
          value={picked}
          onChange={setPicked}
          exclude={players.map((player) => player.playerId)}
          testId="pickup-mod-setting-player"
        />
      </Box>
      {rows.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {t('pickup.moderation.noPlayers')}
        </Typography>
      )}
      {rows.map((player) => (
        <PlayerRow
          key={`${player.playerId}:${player.multiplier}:${player.displayNames.join('|')}`}
          player={player}
          busy={busy}
          onSave={(playerId, change) => {
            onSave(playerId, change);
            setPicked(null);
          }}
        />
      ))}
    </Panel>
  );
}
