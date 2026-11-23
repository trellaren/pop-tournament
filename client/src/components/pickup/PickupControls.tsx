/** The middle column of a pickup lobby: the settings and the host's controls. */
import { Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Panel } from '../common/ui';
import type { PickupCommand, PickupLobby } from './pickupApi';

interface PickupControlsProps {
  lobby: PickupLobby;
  busy: boolean;
  onCommand: (command: PickupCommand) => void;
}

const TEAM_SIZES = [1, 2, 3, 4, 5];

export function PickupControls({ lobby, busy, onCommand }: PickupControlsProps) {
  const { t } = useTranslation();
  const { can, version } = lobby;
  const manages = can.close;

  return (
    <Panel sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Typography variant="h6" component="h2">
        {t('pickup.settings.title')}
      </Typography>
      {can.set_settings ? (
        <TextField
          select
          size="small"
          label={t('pickup.settings.teamSize')}
          value={lobby.settings.teamSize}
          disabled={busy}
          onChange={(event) =>
            onCommand({ type: 'set_settings', teamSize: Number(event.target.value) })
          }
          slotProps={{ htmlInput: { 'data-testid': 'pickup-team-size' } }}
        >
          {TEAM_SIZES.map((size) => (
            <MenuItem key={size} value={size}>
              {t('pickup.settings.versus', { size })}
            </MenuItem>
          ))}
        </TextField>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {t('pickup.settings.versus', { size: lobby.settings.teamSize })}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        {lobby.teamsLocked ? t('pickup.teamsLocked') : t('pickup.teamsOpen')}
      </Typography>

      {manages && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Button
            variant="outlined"
            disabled={busy || !can.scramble}
            data-testid="pickup-scramble"
            onClick={() => onCommand({ type: 'scramble', version })}
          >
            {t('pickup.controls.scramble')}
          </Button>
          <Button
            variant="outlined"
            disabled={busy || !can.balance}
            data-testid="pickup-balance"
            onClick={() => onCommand({ type: 'balance', version })}
          >
            {t('pickup.controls.balance')}
          </Button>
          <Button
            variant="outlined"
            disabled={busy}
            data-testid="pickup-lock"
            onClick={() => onCommand({ type: 'lock_teams', locked: !lobby.teamsLocked })}
          >
            {lobby.teamsLocked ? t('pickup.controls.unlock') : t('pickup.controls.lock')}
          </Button>
          <Button
            variant="outlined"
            color="error"
            disabled={busy}
            data-testid="pickup-close"
            onClick={() => onCommand({ type: 'close', version })}
          >
            {t('pickup.controls.close')}
          </Button>
        </Box>
      )}

      {can.leave && (
        <Button
          disabled={busy}
          data-testid="pickup-leave"
          onClick={() => onCommand({ type: 'leave' })}
        >
          {t('pickup.leave')}
        </Button>
      )}
    </Panel>
  );
}
