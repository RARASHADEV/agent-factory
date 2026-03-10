import chalk from 'chalk';

// Minimal shape required by formatTaskLine — satisfied by both TaskMeta and Task.
interface TaskLike {
  ticket: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  assignee?: string;
}

export function priorityColor(priority: string): string {
  switch (priority) {
    case 'critical': return chalk.red.bold(priority);
    case 'high': return chalk.red(priority);
    case 'medium': return chalk.yellow(priority);
    case 'low': return chalk.dim(priority);
    default: return priority;
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case 'blocked': return chalk.red.bold(status);
    case 'in-progress': return chalk.cyan(status);
    case 'open': return chalk.green(status);
    case 'backlog': return chalk.dim(status);
    case 'ready-for-qa':
    case 'uat': return chalk.magenta(status);
    case 'ready-4-release': return chalk.blue(status);
    case 'released':
    case 'closed': return chalk.dim.strikethrough(status);
    default: return status;
  }
}

export function typeIcon(type: string): string {
  switch (type) {
    case 'bug': return '🐛';
    case 'feature': return '✨';
    case 'improvement': return '⬆️';
    case 'chore': return '🔧';
    case 'epic': return '🏔️';
    case 'task': return '📋';
    case 'spike': return '🔍';
    default: return '•';
  }
}

export function formatTaskLine(meta: TaskLike): string {
  const ticket = chalk.bold(meta.ticket);
  const title = meta.title;
  const status = statusColor(meta.status);
  const priority = priorityColor(meta.priority);
  const assignee = meta.assignee ? chalk.dim(`@${meta.assignee}`) : '';
  const icon = typeIcon(meta.type);

  return `${icon} ${ticket}  ${title}  [${status}]  ${priority}  ${assignee}`.trimEnd();
}

export function heading(text: string): string {
  return chalk.bold.underline(text);
}

export function dim(text: string): string {
  return chalk.dim(text);
}

export function success(text: string): string {
  return chalk.green(`✓ ${text}`);
}

export function error(text: string): string {
  return chalk.red(`✗ ${text}`);
}

export function warn(text: string): string {
  return chalk.yellow(`⚠ ${text}`);
}
