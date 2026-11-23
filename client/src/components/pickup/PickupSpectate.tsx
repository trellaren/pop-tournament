/**
 * Spectate, on the running match's card: for someone in the lobby who is not
 * playing. Pressing it puts them on the match's spectator list and shows how
 * to join the server. The line is shown here and never kept.
 */
import React from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage } from '../../utils/api';
import { copyTextToClipboard } from '../../utils/clipboard';
import type { Untrusted } from '../../utils/untrusted';
import {
  pickupRefusalCode,
  spectatePickupMatch,
  type PickupConnect,
  type PickupLobby,
} from './pickupApi';
import { usePickupHost } from './pickupHost';

/** The console line that joins a server. */
export function connectLine(connect: PickupConnect): string {
  const address = `connect ${connect.host}:${connect.port}`;
  return connect.password ? `${address}; password ${connect.password}` : address;
}

export function PickupSpectate({ lobby }: { lobby: PickupLobby }) {
  const { t } = useTranslation();
  const host = usePickupHost();
  const [asked, setAsked] = React.useState(false);
  const [connect, setConnect] = React.useState<PickupConnect | null>(null);
  const [error, setError] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const slug = lobby.match?.slug ?? null;

  // Another match: what was shown belongs to the last one.
  React.useEffect(() => {
    setAsked(false);
    setConnect(null);
    setError('');
    setCopied(false);
  }, [slug]);

  if (!lobby.maySpectate) return null;

  const spectate = () => {
    setError('');
    spectatePickupMatch(lobby.id)
      .then((answer) => {
        setAsked(true);
        setConnect(answer);
      })
      .catch((err: Untrusted) => {
        const code = pickupRefusalCode(err);
        setError(t(`pickup.refusal.${code ?? 'unknown'}`, apiErrorMessage(err, t('pickup.error'))));
      });
  };
  const line = connect ? connectLine(connect) : '';
  const steamLink = connect
    ? `steam://connect/${connect.ip ?? connect.host}:${connect.port}${connect.password ? `/${connect.password}` : ''}`
    : '';

  return (
    <Box sx={{ mt: 1.5 }} data-testid="pickup-spectate-box">
      <Button variant="outlined" size="small" data-testid="pickup-spectate" onClick={spectate}>
        {t('pickup.spectate.button')}
      </Button>
      {error && (
        <Typography variant="body2" color="error" role="alert" sx={{ mt: 1 }}>
          {error}
        </Typography>
      )}
      {asked && !connect && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('pickup.spectate.noServer')}
        </Typography>
      )}
      {connect && (
        <Box sx={{ mt: 1, display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography
            variant="body2"
            sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
            data-testid="pickup-spectate-line"
          >
            {line}
          </Typography>
          <Button size="small" onClick={() => void copyTextToClipboard(line).then(setCopied)}>
            {copied ? t('pickup.spectate.copied') : t('pickup.spectate.copy')}
          </Button>
          {!host.openOutside && (
            <Button size="small" component="a" href={steamLink}>
              {t('pickup.spectate.join')}
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
}
