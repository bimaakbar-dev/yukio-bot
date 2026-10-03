import type { CommandDefinition } from './registry';

import { pingCommand } from './ping';
import { helpCommand } from './help';
import { statusCommand } from './status';
import { animeCommand } from './anime';
import { aiCommand } from './ai';

export const COMMANDS: CommandDefinition[] = [
  pingCommand,
  helpCommand,
  statusCommand,
  animeCommand,
  aiCommand,
];