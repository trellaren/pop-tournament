/**
 * Who can join, for the lobby's host and admins: the invite list with Revoke,
 * inviting a player by name, and a link to hand out.
 */
import React from 'react';
import { Box, Button, Chip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Panel } from '../common/ui';
import { PlayerPicker, type PickedPlayer } from '../common/PlayerPicker';
import { copyTextToClipboard } from '../../utils/clipboard';
import { makePickupInviteLink, type PickupCommand, type PickupLobby } from './pickupApi';
import { usePickupHost } from './pickupHost';

interface PickupInvitesProps {
  lobby: PickupLobby;
  busy: boolean;
  onCommand: (command: PickupCommand) => void;
}

export function PickupInvites({ lobby, busy, onCommand }: PickupInvitesProps) {
  const { t } = useTranslation();
  const { siteOrigin } = usePickupHost();
  const [picked, setPicked] = React.useState<PickedPlayer | null>(null);
  const [link, setLink] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  if (!lobby.can.invite) return null;
  const inviteOnly = lobby.settings.visibility === 'invite';

  const makeLink = () => {
    setFailed(false);
    makePickupInviteLink(lobby.id)
      .then(async (path) => {
        const address = `${siteOrigin}${path}`;
        setLink(address);
        setCopied(await copyTextToClipboard(address));
      })
      .catch(() => setFailed(true));
  };

  return (
    <Panel sx={{ p: 2 }} data-testid="pickup-invites">
      <Typography variant="h6" component="h2">
        {t('pickup.invites.title')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {inviteOnly ? t('pickup.invites.hintInvite') : t('pickup.invites.hintOpen')}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
        <Box sx={{ flex: '1 1 14rem', minWidth: '12rem' }}>
          <PlayerPicker
            label={t('pickup.invites.player')}
            value={picked}
            onChange={setPicked}
            exclude={lobby.invited.map((p) => p.playerId)}
            testId="pickup-invite-player"
          />
        </Box>
        <Button
          variant="contained"
          disabled={busy || !picked}
          data-testid="pickup-invite"
          onClick={() => {
            if (!picked) return;
            onCommand({ type: 'invite', playerId: picked.steamid64 });
            setPicked(null);
          }}
        >
          {t('pickup.invites.invite')}
        </Button>
        <Button variant="outlined" data-testid="pickup-invite-link" onClick={makeLink}>
          {t('pickup.invites.copyLink')}
        </Button>
      </Box>
      {failed && (
        <Typography variant="body2" color="error" role="alert">
          {t('pickup.error')}
        </Typography>
      )}
      {link && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mb: 1.5, wordBreak: 'break-all' }}
          data-testid="pickup-invite-link-text"
        >
          {copied ? t('pickup.invites.copied') : t('pickup.invites.copyYourself')} {link}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }} data-testid="pickup-invited">
        {lobby.invited.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t('pickup.invites.none')}
          </Typography>
        )}
        {lobby.invited.map((person) => (
          <Chip
            key={person.playerId}
            label={person.name}
            variant={person.inLobby ? 'filled' : 'outlined'}
            disabled={busy}
            onDelete={() => onCommand({ type: 'revoke_invite', playerId: person.playerId })}
            data-testid={`pickup-invited-${person.playerId}`}
          />
        ))}
      </Box>
    </Panel>
  );
}
