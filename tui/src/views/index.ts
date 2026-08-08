import type { ComponentType } from 'react';

import { Issues, Pulls, Runs } from './github.js';
import { Sprints, Workitems } from './jira.js';
import { Overview } from './overview.js';
import { Digest, History, Insights } from './reports.js';
import type { ViewProps } from './list.js';

export type ViewId =
  | 'overview'
  | 'issues'
  | 'pulls'
  | 'runs'
  | 'workitems'
  | 'sprints'
  | 'insights'
  | 'digest'
  | 'history';

export interface ViewEntry {
  id: ViewId;
  title: string;
  component: ComponentType<ViewProps>;
}

/**
 * The web viewer's navigation, in the same order, plus History — which has no
 * web equivalent yet and needs no chart library here.
 */
export const VIEWS: ViewEntry[] = [
  { id: 'overview', title: 'Overview', component: Overview },
  { id: 'issues', title: 'GitHub issues', component: Issues },
  { id: 'pulls', title: 'Pull requests', component: Pulls },
  { id: 'runs', title: 'Workflow runs', component: Runs },
  { id: 'workitems', title: 'Jira work items', component: Workitems },
  { id: 'sprints', title: 'Sprints', component: Sprints },
  { id: 'insights', title: 'Insights', component: Insights },
  { id: 'digest', title: 'Digest', component: Digest },
  { id: 'history', title: 'History', component: History },
];

export type { ViewProps };
