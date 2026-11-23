/**
 * Discord's side of the pickup Activity: the Embedded App SDK. Only this file
 * imports it, and only the Activity page loads this file, so the SDK is in no
 * other bundle. Outside Discord the SDK's constructor throws (it reads
 * frame_id and instance_id from the address); the page then says to open it
 * from Discord.
 */
import { DiscordSDK } from '@discord/embedded-app-sdk';

export interface ActivityHost {
  /** Ask Discord for a sign-in code for the person in front of the frame. */
  authorize: (clientId: string) => Promise<string>;
  /** Tell the SDK who signed in, with Discord's own access token. */
  authenticate: (accessToken: string) => Promise<void>;
  /** Open an address in the person's browser, outside Discord. */
  openExternal: (url: string) => void;
}

export async function connectActivityHost(clientId: string): Promise<ActivityHost> {
  const sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
  await sdk.ready();
  return {
    authorize: async (id) => {
      const { code } = await sdk.commands.authorize({
        client_id: id,
        response_type: 'code',
        scope: ['identify'],
        prompt: 'none',
      });
      return code;
    },
    authenticate: async (accessToken) => {
      await sdk.commands.authenticate({ access_token: accessToken });
    },
    openExternal: (url) => {
      void sdk.commands.openExternalLink({ url });
    },
  };
}
