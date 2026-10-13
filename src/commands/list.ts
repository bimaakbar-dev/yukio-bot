// src/commands/list.ts
import type { CommandDefinition } from './registry';
import { helpCommand } from './help';
import { statusCommand } from './status';
import { animeCommand } from './anime';
import { databaseCommand } from './database';
import { decodeCommand } from './decode';
import { batchCommand } from './batch';
import { trackCommand } from './track';
import { vaCommand } from './va';
import { aiCommand } from './ai';
import { killCommand } from './kill';

export const COMMANDS: CommandDefinition[] = [
  helpCommand,
  statusCommand,
  animeCommand,
  databaseCommand,
  decodeCommand,
  batchCommand,
  trackCommand,
  vaCommand,
  aiCommand,
  killCommand,
];