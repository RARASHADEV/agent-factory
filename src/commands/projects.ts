import chalk from 'chalk';
import { listProjects } from '../lib/workspace.js';
import { listTasks } from '../lib/workspace.js';
import { heading, dim } from '../lib/format.js';

export function projectsCommand(): void {
  const projects = listProjects();

  if (projects.length === 0) {
    console.log(dim('No projects registered. Run `af init <prefix>` in a project directory.'));
    return;
  }

  console.log(heading('Projects'));
  console.log('');

  for (const project of projects) {
    const tasks = listTasks(project.afPath);
    const inProgress = tasks.filter(t => t.meta.status === 'in-progress').length;
    const open = tasks.filter(t => t.meta.status === 'open').length;
    const backlog = tasks.filter(t => t.meta.status === 'backlog').length;
    const blocked = tasks.filter(t => t.meta.status === 'blocked').length;

    const statusBadge = project.meta.status === 'active'
      ? chalk.green('● active')
      : chalk.dim(`○ ${project.meta.status}`);

    console.log(`  ${chalk.bold(project.meta.prefix)}  ${project.meta.name}  ${statusBadge}`);

    const counts: string[] = [];
    if (inProgress) counts.push(chalk.cyan(`${inProgress} in-progress`));
    if (open) counts.push(chalk.green(`${open} open`));
    if (backlog) counts.push(chalk.dim(`${backlog} backlog`));
    if (blocked) counts.push(chalk.red(`${blocked} blocked`));

    if (counts.length > 0) {
      console.log(`       ${counts.join('  ')}`);
    } else {
      console.log(dim(`       No tasks`));
    }

    console.log(dim(`       ${project.entry.path}`));
    console.log('');
  }
}
