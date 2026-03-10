import chalk from 'chalk';
import { listProjects } from '../lib/workspace.js';
import { FileProvider } from '../lib/providers/file-provider.js';
import { heading, dim } from '../lib/format.js';

export async function projectsCommand(): Promise<void> {
  const projects = listProjects();

  if (projects.length === 0) {
    console.log(dim('No projects registered. Run `af init <prefix>` in a project directory.'));
    return;
  }

  console.log(heading('Projects'));
  console.log('');

  for (const project of projects) {
    const provider = new FileProvider(project.afPath, project.meta);
    const tasks = await provider.list();
    const inProgress = tasks.filter(t => t.status === 'in-progress').length;
    const open = tasks.filter(t => t.status === 'open').length;
    const backlog = tasks.filter(t => t.status === 'backlog').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;

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
