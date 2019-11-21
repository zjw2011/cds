import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component, ElementRef,
    EventEmitter,
    Input,
    OnInit,
    Output, ViewChild
} from '@angular/core';
import { Store } from '@ngxs/store';
import { IPopup } from '@richardlt/ng2-semantic-ui';
import { PipelineStatus } from 'app/model/pipeline.model';
import { Project } from 'app/model/project.model';
import { WNode, Workflow } from 'app/model/workflow.model';
import { WorkflowNodeRun, WorkflowRun } from 'app/model/workflow.run.model';
import { AutoUnsubscribe } from 'app/shared/decorator/autoUnsubscribe';
import { WorkflowState, WorkflowStateModel } from 'app/store/workflow.state';
import { Subscription } from 'rxjs';

@Component({
    selector: 'app-workflow-menu-wnode-edit',
    templateUrl: './menu.edit.node.html',
    styleUrls: ['./menu.edit.node.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
@AutoUnsubscribe()
export class WorkflowWNodeMenuEditComponent implements OnInit {

    @ViewChild('container', {static: false}) container: ElementRef;

    // Project that contains the workflow
    project: Project;
    node: WNode;

    _noderun: WorkflowNodeRun;
    @Input('noderun') set noderun(data: WorkflowNodeRun) {
        this._noderun = data;
        this.runnable = this.getCanBeRun();
    }
    get noderun() { return this._noderun }

    _workflowrun: WorkflowRun;
    @Input('workflowrun') set workflowrun(data: WorkflowRun) {
        this._workflowrun = data;
        this.runnable = this.getCanBeRun();
    }
    get workflowrun() { return this._workflowrun }

    readonly = true;
    @Output() event = new EventEmitter<string>();
    runnable: boolean;
    storeSubscription: Subscription;
    workflow: Workflow;
    display = false;

    constructor(
        private _store: Store,
        private _cd: ChangeDetectorRef
    ) { }

    show(p: Project, n: WNode, readonly: boolean, x, y: number) {
        this.project = p;
        this.node = n;
        this.readonly = readonly;
        this.display = true;
        console.log(x, y, this.container);
        this.container.nativeElement.style.top = y;
        this.container.nativeElement.style.left = x;
        this.container.nativeElement.style.setProperty('top', y.toString()+ 'px');
        this.container.nativeElement.style.setProperty('left', x.toString()+ 'px');
        this._cd.detectChanges();
    }

    ngOnInit(): void {
        this.storeSubscription = this._store.select(WorkflowState.getCurrent())
            .subscribe((s: WorkflowStateModel) => {
            console.log(s.workflow);
            this.workflow = s.workflow;
            this.runnable = this.getCanBeRun();
            this._cd.markForCheck();
        });
    }

    sendEvent(e: string): void {
        this.event.emit(e);
    }

    getCanBeRun(): boolean {
        if (!this.workflow) {
            return;
        }

        if (this.workflow && !this.workflow.permissions.executable) {
            return false;
        }

        // If we are in a run, check if current node can be run ( compuite by cds api)
        if (this.noderun && this.workflowrun && this.workflowrun.nodes) {
            let nodesRun = this.workflowrun.nodes[this.noderun.workflow_node_id];
            if (nodesRun) {
                let nodeRun = nodesRun.find(n => {
                    return n.id === this.noderun.id;
                });
                if (nodeRun) {
                    return nodeRun.can_be_run;
                }
            }
            return false;
        }

        let workflowrunIsNotActive = this.workflowrun && !PipelineStatus.isActive(this.workflowrun.status);
        if (workflowrunIsNotActive && this.noderun) {
            return true;
        }

        if (this.node && this.workflowrun) {
            if (workflowrunIsNotActive && !this.noderun &&
                this.node.id === this.workflowrun.workflow.workflow_data.node.id) {
                return true;
            }

            if (this.workflowrun && this.workflowrun.workflow && this.workflowrun.workflow.workflow_data) {
                let nbNodeFound = 0;
                let parentNodes = Workflow.getParentNodeIds(this.workflowrun, this.node.id);
                for (let parentNodeId of parentNodes) {
                    for (let nodeRunId in this.workflowrun.nodes) {
                        if (!this.workflowrun.nodes[nodeRunId]) {
                            continue;
                        }
                        let nodeRuns = this.workflowrun.nodes[nodeRunId];
                        if (nodeRuns[0].workflow_node_id === parentNodeId) { // if node id is still the same
                            if (PipelineStatus.isActive(nodeRuns[0].status)) {
                                return false;
                            }
                            nbNodeFound++;
                        } else if (!Workflow.getNodeByID(nodeRuns[0].workflow_node_id, this.workflowrun.workflow)) {
                            // workflow updated so prefer return true
                            return true;
                        }
                    }
                }
                if (nbNodeFound !== parentNodes.length) { // It means that a parent node isn't already executed
                    return false;
                }
            }
        }
        return true;
    }
}
