/**
 * Ban a player from pickup lobbies, for moderators and admins: how long, and
 * a reason only moderators see. The player is told until when, never why.
 */
import React from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage } from '../../utils/api';
import type { Untrusted } from '../../utils/untrusted';
import { banFromPickup } from './pickupApi';

const HOUR = 60 * 60;
/** Lengths offered, in seconds; 0 stands for "until lifted". */
const LENGTHS = [HOUR, 24 * HOUR, 7 * 24 * HOUR, 30 * 24 * HOUR, 0] as const;
const MAX_REASON = 200;

interface PickupBanDialogProps {
  player: { playerId: string; name: string } | null;
  onClose: () => void;
  onBanned: () => void;
}

export function PickupBanDialog({ player, onClose, onBanned }: PickupBanDialogProps) {
  const { t } = useTranslation();
  const [length, setLength] = React.useState<number>(0);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    setLength(0);
    setReason('');
    setError('');
  }, [player?.playerId]);

  const ban = () => {
    if (!player) return;
    setBusy(true);
    setError('');
    banFromPickup(player.playerId, length === 0 ? null : length, reason)
      .then(onBanned)
      .catch((err: Untrusted) => setError(apiErrorMessage(err, t('pickup.error'))))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={player !== null} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t('pickup.ban.title', { player: player?.name ?? '' })}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {t('pickup.ban.hint')}
        </Typography>
        <TextField
          select
          size="small"
          label={t('pickup.ban.length')}
          value={length}
          onChange={(event) => setLength(Number(event.target.value))}
          slotProps={{ htmlInput: { 'data-testid': 'pickup-ban-length' } }}
        >
          {LENGTHS.map((seconds) => (
            <MenuItem key={seconds} value={seconds}>
              {t(`pickup.ban.lengths.${seconds}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label={t('pickup.ban.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value.slice(0, MAX_REASON))}
          helperText={t('pickup.ban.reasonHint')}
          slotProps={{ htmlInput: { 'data-testid': 'pickup-ban-reason', maxLength: MAX_REASON } }}
        />
        {error && (
          <Typography variant="body2" color="error" role="alert">
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('pickup.ban.cancel')}</Button>
        <Button
          color="error"
          variant="contained"
          disabled={busy}
          data-testid="pickup-ban-confirm"
          onClick={ban}
        >
          {t('pickup.ban.confirm')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
