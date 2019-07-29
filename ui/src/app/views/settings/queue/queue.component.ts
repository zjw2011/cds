import { Component } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Store } from '@ngxs/store';
import { EventWorkflowNodeJobRunPayload } from 'app/model/event.model';
import { PipelineStatus } from 'app/model/pipeline.model';
import { User } from 'app/model/user.model';
import { WorkflowRunService } from 'app/service/workflow/run/workflow.run.service';
import { PathItem } from 'app/shared/breadcrumb/breadcrumb.component';
import { AutoUnsubscribe } from 'app/shared/decorator/autoUnsubscribe';
import { ToastService } from 'app/shared/toast/ToastService';
import { AuthenticationState } from 'app/store/authentication.state';
import { GetQueue } from 'app/store/queue.action';
import { QueueState, QueueStateModel } from 'app/store/queue.state';
import { Subscription } from 'rxjs';
import { finalize } from 'rxjs/operators';

@Component({
    selector: 'app-queue',
    templateUrl: './queue.component.html',
    styleUrls: ['./queue.component.scss']
})
@AutoUnsubscribe()
export class QueueComponent {
    queueSubscription: Subscription;
    nodeJobRuns: Array<EventWorkflowNodeJobRunPayload> = [];
    parametersMaps: Array<{}> = [];
    requirementsList: Array<string> = [];
    bookedOrBuildingByList: Array<string> = [];
    loading: boolean;
    statusOptions: Array<string> = [PipelineStatus.WAITING, PipelineStatus.BUILDING];
    status: Array<string>;
    path: Array<PathItem>;
    user: User;

    constructor(
        private _store: Store,
        private _wfRunService: WorkflowRunService,
        private _toast: ToastService,
        private _translate: TranslateService
    ) {
        this.loading = true;
        this.status = [this.statusOptions[0]];
        this.user = this._store.selectSnapshot(AuthenticationState.user);

        this.queueSubscription = this._store.select(QueueState.getCurrent()).subscribe((s: QueueStateModel) => {
            this.nodeJobRuns = s.queue;
            this.loading = s.loading;
            if (Array.isArray(this.nodeJobRuns) && this.nodeJobRuns.length > 0) {
                this.requirementsList = [];
                this.bookedOrBuildingByList = [];
                this.parametersMaps = this.nodeJobRuns.map((nj) => {
                    if (this.user.admin && nj.Requirements) {
                        let requirements = nj.Requirements
                            .reduce((reqs, req) => `type: ${req.Type}, value: ${req.Value}; ${reqs}`, '');
                        this.requirementsList.push(requirements);
                    }
                    this.bookedOrBuildingByList.push(((): string => {
                        if (nj.Status === PipelineStatus.BUILDING) {
                            return nj.WorkerName;
                        }
                        if (nj.BookByName) {
                            return nj.BookByName;
                        }
                        return '';
                    })());
                    if (nj.Parameters) {
                        return null;
                    }
                    return nj.Parameters.reduce((params, param) => {
                        params[param.Name] = param.Value;
                        return params;
                    }, {});
                });
            }
        });

        this.refreshQueue();

        this.path = [<PathItem>{
            translate: 'common_settings'
        }, <PathItem>{
            translate: 'admin_queue_title'
        }];
    }

    refreshQueue(): void {
        this._store.dispatch(new GetQueue({ status: (this.status.length > 0 ? this.status : this.statusOptions)}));
    }


    stopNode(index: number) {
        let parameters = this.parametersMaps[index];
        this.nodeJobRuns[index].updating = true;
        this._wfRunService.stopNodeRun(
            parameters['cds.project'],
            parameters['cds.workflow'],
            parseInt(parameters['cds.run.number'], 10),
            parseInt(parameters['cds.node.id'], 10)
        ).pipe(finalize(() => this.nodeJobRuns[index].updating = false))
            .subscribe(() => this._toast.success('', this._translate.instant('pipeline_stop')))
    }
}
