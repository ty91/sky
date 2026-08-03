/**
 * Single source of truth for the Slack app Sky needs.
 *
 * The bot scopes and bot events declared here feed three consumers that used to
 * drift apart: the shipped app manifest, the `sky slack manifest` onboarding
 * deep link, and the Slack bot connection check in `../connections.ts`.
 *
 * This module must stay dependency-free. CLI commands import it without paying
 * for the Bolt/agent-backend import chain.
 */

/**
 * Why each scope is required. Declared as a keyed record so adding a scope to
 * `REQUIRED_SLACK_BOT_SCOPES` without justifying it fails typecheck.
 */
export const REQUIRED_SLACK_BOT_SCOPES = [
  'app_mentions.read',
  'assistant:write',
  'channels:history',
  'chat:write',
  'files:read',
  'files:write',
  'groups:history',
  'im:history',
  'reactions:write',
  'users:read',
] as const;

export type RequiredSlackBotScope = (typeof REQUIRED_SLACK_BOT_SCOPES)[number];

export const SLACK_BOT_SCOPE_REASONS: Record<RequiredSlackBotScope, string> = {
  'app_mentions.read': 'Receive app_mention events when Sky is mentioned in a channel.',
  'assistant:write': 'Call assistant.threads.setStatus and setSuggestedPrompts.',
  'channels:history': 'Read public channel thread history before the first mention.',
  'chat:write': 'Post replies with chat.postMessage.',
  'files:read': 'Download user-attached files from url_private_download.',
  'files:write': 'Upload agent-produced files with files.uploadV2.',
  'groups:history': 'Read private channel thread history before the first mention.',
  'im:history': 'Receive and read direct message history.',
  'reactions:write': 'Add and remove the channel activity indicator reaction.',
  'users:read': 'Resolve Slack user display names with users.info.',
};

/**
 * Bot events Sky actually consumes. Sky runs the agent messaging experience
 * (`agent_view`), where a root DM starts a conversation and Sky replies
 * in-thread, so it does not subscribe to the `assistant_thread_*` events that
 * only fire for the legacy assistant messaging experience.
 */
export const REQUIRED_SLACK_BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
] as const;

export type RequiredSlackBotEvent = (typeof REQUIRED_SLACK_BOT_EVENTS)[number];

export const SLACK_BOT_EVENT_REASONS: Record<RequiredSlackBotEvent, string> = {
  app_mention: 'Start a channel thread conversation when Sky is mentioned.',
  'message.channels': 'Continue public channel threads that already have a conversation.',
  'message.groups': 'Continue private channel threads that already have a conversation.',
  'message.im': 'Handle direct messages, both the root message and thread replies.',
};

export const SLACK_APP_NAME = 'Sky';

export const DEFAULT_SUGGESTED_PROMPTS = [
  { title: '오늘 할 일', message: '오늘 내가 해야 할 일을 정리해줘' },
  { title: '코드 리뷰', message: '최근 변경사항을 리뷰해줘' },
  { title: '아이디어 브레인스토밍', message: '새로운 기능 아이디어를 함께 생각해보자' },
] as const;

export const SLACK_APP_CONSOLE_URL = 'https://api.slack.com/apps';

export type SlackAppManifest = {
  display_information: {
    name: string;
    description: string;
    background_color: string;
  };
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
    agent_view: {
      agent_description: string;
      suggested_prompts: Array<{ title: string; message: string }>;
    };
  };
  oauth_config: {
    scopes: {
      bot: string[];
    };
  };
  settings: {
    event_subscriptions: {
      bot_events: string[];
    };
    interactivity: {
      is_enabled: boolean;
    };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
};

export function buildSlackAppManifest(): SlackAppManifest {
  return {
    display_information: {
      name: SLACK_APP_NAME,
      description: 'Slack에서 코딩 에이전트와 대화하는 개인용 봇',
      background_color: '#1f2933',
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: SLACK_APP_NAME,
        always_online: true,
      },
      agent_view: {
        agent_description: 'DM으로 대화하고 채널에서 멘션으로 부를 수 있는 코딩 에이전트입니다.',
        suggested_prompts: DEFAULT_SUGGESTED_PROMPTS.map((prompt) => ({ ...prompt })),
      },
    },
    oauth_config: {
      scopes: {
        bot: [...REQUIRED_SLACK_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [...REQUIRED_SLACK_BOT_EVENTS],
      },
      interactivity: {
        is_enabled: false,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/** Pretty JSON for the checked-in artifact, `sky slack manifest`, and copy-paste. */
export function serializeSlackAppManifest(
  manifest: SlackAppManifest = buildSlackAppManifest(),
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Deep link into Slack's "create app from manifest" flow. Slack still shows the
 * manifest for review and requires an explicit Create, so this only removes the
 * manual field-by-field entry.
 */
export function slackAppCreateUrl(
  manifest: SlackAppManifest = buildSlackAppManifest(),
): string {
  return `${SLACK_APP_CONSOLE_URL}?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export function missingSlackBotScopes(grantedScopes: Iterable<string>): RequiredSlackBotScope[] {
  const granted = new Set(grantedScopes);
  return REQUIRED_SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope));
}

/**
 * The one remediation sentence every scope-shortfall surface points at, so the
 * diagnosis always ends in the same executable action.
 */
export function slackManifestRemediation(missingScopes: readonly string[] = []): string {
  const prefix =
    missingScopes.length > 0 ? `Missing Slack bot scopes: ${missingScopes.join(', ')}. ` : '';
  return `${prefix}Re-apply the Sky app manifest (\`sky slack manifest\`), then reinstall the app to the workspace and replace the bot token.`;
}
