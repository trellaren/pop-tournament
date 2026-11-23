/**
 * Mid-match substitution, under the teams while a match runs: the host or an
 * admin picks who goes out and who comes in from the waiting room; a
 * substitution the match server did not take offers Retry and Undo.
 */
import React from 'react';
import { Alert, Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Panel } from '../common/ui';
import type { PickupCommand, PickupLobby } from './pickupApi';

interface PickupSubstituteProps {
  lobby: PickupLobby;
  busy: boolean;
  onCommand: (command: PickupCommand) => void;
}

export function PickupSubstitute({ lobby, busy, onCommand }: PickupSubstituteProps) {
  const { t } = useTranslation();
  const [outId, setOutId] = React.useState('');
  const [inId, setInId] = React.useState('');
  const { can, version, subFailed } = lobby;

  if (lobby.state !== 'in_match') return null;
  const seated = [...lobby.teams.a, ...lobby.teams.b];
  const coming = lobby.waiting.filter((p) => lobby.substitutes.includes(p.playerId));
  const out = seated.some((p) => p.playerId === outId) ? outId : '';
  const incoming = coming.some((p) => p.playerId === inId) ? inId : '';
  if (!can.substitute && !subFailed && lobby.leavers.length === 0) return null;

  return (
    <Panel sx={{ p: 2 }} data-testid="pickup-substitute">
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        {t('pickup.substitute.title')}
      </Typography>
      {subFailed && (
        <Alert
          severity="warning"
          sx={{ mb: 1.5 }}
          data-testid="pickup-sub-failed"
          action={
            can.substitution_action ? (
              <>
                <Button
                  color="inherit"
                  size="small"
                  disabled={busy}
                  data-testid="pickup-sub-retry"
                  onClick={() =>
                    onCommand({ type: 'substitution_action', action: 'retry', version })
                  }
                >
                  {t('pickup.substitute.retry')}
                </Button>
                <Button
                  color="inherit"
                  size="small"
                  disabled={busy}
                  data-testid="pickup-sub-undo"
                  onClick={() =>
                    onCommand({ type: 'substitution_action', action: 'undo', version })
                  }
                >
                  {t('pickup.substitute.undo')}
                </Button>
              </>
            ) : undefined
          }
        >
          {t('pickup.substitute.failed', { in: subFailed.inName, out: subFailed.outName })}
        </Alert>
      )}
      {can.substitute && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            select
            size="small"
            label={t('pickup.substitute.out')}
            value={out}
            disabled={busy}
            onChange={(event) => setOutId(event.target.value)}
            sx={{ minWidth: '12rem' }}
            slotProps={{ htmlInput: { 'data-testid': 'pickup-sub-out' } }}
          >
            {seated.map((p) => (
              <MenuItem key={p.playerId} value={p.playerId}>
                {p.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label={t('pickup.substitute.in')}
            value={incoming}
            disabled={busy}
            onChange={(event) => setInId(event.target.value)}
            sx={{ minWidth: '12rem' }}
            slotProps={{ htmlInput: { 'data-testid': 'pickup-sub-in' } }}
          >
            {coming.map((p) => (
              <MenuItem key={p.playerId} value={p.playerId}>
                {p.name}
              </MenuItem>
            ))}
          </TextField>
          <Button
            variant="contained"
            disabled={busy || !out || !incoming}
            data-testid="pickup-sub-go"
            onClick={() => {
              onCommand({ type: 'substitute', outId: out, inId: incoming, version });
              setOutId('');
              setInId('');
            }}
          >
            {t('pickup.substitute.go')}
          </Button>
        </Box>
      )}
      {lobby.leavers.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          {t('pickup.substitute.left', { names: lobby.leavers.map((p) => p.name).join(', ') })}
        </Typography>
      )}
    </Panel>
  );
}
