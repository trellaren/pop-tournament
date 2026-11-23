/**
 * The practice and retakes servers that are online, on the Pickup page:
 * anyone signed in joins one on their own. An admin decides which servers
 * these are with the plugin sets on the Servers page.
 */
import React from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Panel } from '../common/ui';
import { copyTextToClipboard } from '../../utils/clipboard';
import { listPickupServers, type PickupModeServer } from './pickupApi';

const MODES = ['practice', 'retakes'] as const;

function ServerRow({ server }: { server: PickupModeServer }) {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  const line = `connect ${server.address}`;
  const [hostName] = server.address.split(':');
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', py: 0.5 }}>
      <Typography sx={{ fontWeight: 600 }}>{server.name}</Typography>
      <Typography variant="body2" sx={{ fontFamily: 'monospace', flex: 1 }}>
        {line}
      </Typography>
      <Button size="small" onClick={() => void copyTextToClipboard(line).then(setCopied)}>
        {copied ? t('pickup.spectate.copied') : t('pickup.spectate.copy')}
      </Button>
      <Button
        size="small"
        variant="outlined"
        component="a"
        href={`steam://connect/${server.connectIp ?? hostName}:${server.port}`}
      >
        {t('pickup.servers.join')}
      </Button>
    </Box>
  );
}

export function PickupServers() {
  const { t } = useTranslation();
  const [servers, setServers] = React.useState<Record<
    (typeof MODES)[number],
    PickupModeServer[]
  > | null>(null);

  React.useEffect(() => {
    listPickupServers()
      .then(setServers)
      .catch(() => setServers(null));
  }, []);

  if (!servers) return null;
  return (
    <Panel sx={{ p: 2, mt: 4 }} data-testid="pickup-servers">
      <Typography variant="h6" component="h2">
        {t('pickup.servers.title')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {t('pickup.servers.hint')}
      </Typography>
      {MODES.map((mode) => (
        <Box key={mode} sx={{ mb: 1.5 }} data-testid={`pickup-servers-${mode}`}>
          <Typography variant="subtitle2">{t(`pickup.servers.mode.${mode}`)}</Typography>
          {servers[mode].length === 0 && (
            <Typography variant="body2" color="text.secondary">
              {t('pickup.servers.none')}
            </Typography>
          )}
          {servers[mode].map((server) => (
            <ServerRow key={server.address} server={server} />
          ))}
        </Box>
      ))}
    </Panel>
  );
}
