import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    QueryList,
    ViewChild,
    ViewChildren
} from '@angular/core';
import { ActivatedRoute, NavigationStart, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Store } from '@ngxs/store';
import { SuiPopup, SuiPopupController, SuiPopupTemplateController } from '@richardlt/ng2-semantic-ui';
import { Project } from 'app/model/project.model';
import { Workflow } from 'app/model/workflow.model';
import { WorkflowRun } from 'app/model/workflow.run.model';
import { AscodeService } from 'app/service/ascode/ascode.service';
import { WorkflowCoreService } from 'app/service/workflow/workflow.core.service';
import { WorkflowSidebarMode } from 'app/service/workflow/workflow.sidebar.store';
import { AutoUnsubscribe } from 'app/shared/decorator/autoUnsubscribe';
import { UpdateAscodeComponent } from 'app/shared/modal/save-as-code/update.Ascode.component';
import { ToastService } from 'app/shared/toast/ToastService';
import { WorkflowTemplateApplyModalComponent } from 'app/shared/workflow-template/apply-modal/workflow-template.apply-modal.component';
import { ProjectState, ProjectStateModel } from 'app/store/project.state';
import {
    CleanWorkflowRun,
    CleanWorkflowState,
    GetWorkflow,
    GetWorkflowRuns,
    SelectHook,
    SidebarRunsMode,
    UpdateFavoriteWorkflow
} from 'app/store/workflow.action';
import { WorkflowState, WorkflowStateModel } from 'app/store/workflow.state';
import { Subscription } from 'rxjs';
import { filter, finalize } from 'rxjs/operators';


@Component({
    selector: 'app-workflow',
    templateUrl: './workflow.html',
    styleUrls: ['./workflow.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
@AutoUnsubscribe()
export class WorkflowComponent {
    @ViewChild('templateApplyModal', { static: false })
    templateApplyModal: WorkflowTemplateApplyModalComponent;

    project: Project;
    workflow: Workflow;
    workflowSubscription: Subscription;
    projectSubscription: Subscription;
    dataRouteSubscription: Subscription;
    qpRouteSubscription: Subscription;
    paramsRouteSubscription: Subscription;
    eventsRouteSubscription: Subscription;

    loading = true;
    loadingFav = false;

    // Sidebar data
    sidebarMode = WorkflowSidebarMode.RUNS;
    sidebarModes = WorkflowSidebarMode;

    editWorkflow: Workflow;

    asCodeEditorSubscription: Subscription;
    asCodeEditorOpen = false;

    @ViewChild('updateAsCode', {static: false})
    saveAsCode: UpdateAscodeComponent;
    @ViewChild('popup', {static: false})
    popupFromlRepository: SuiPopup;
    @ViewChildren(SuiPopupController) popups: QueryList<SuiPopupController>;
    @ViewChildren(SuiPopupTemplateController) popups2: QueryList<SuiPopupTemplateController<SuiPopup>>;

    selectedNodeID: number;
    selectedNodeRef: string;
    selectecHookRef: string;

    workflowRun: WorkflowRun;

    showButtons = false;
    loadingPopupButton = false;

    constructor(
        private _activatedRoute: ActivatedRoute,
        private _router: Router,
        private _workflowCore: WorkflowCoreService,
        private _toast: ToastService,
        private _translate: TranslateService,
        private _store: Store,
        private _cd: ChangeDetectorRef,
        private _ascodeService: AscodeService
    ) {
        this.dataRouteSubscription = this._activatedRoute.data.subscribe(datas => {
            this.project = datas['project'];
        });

        this.projectSubscription = this._store.select(ProjectState)
            .pipe(filter((projState) => projState.project && projState.project.key))
            .subscribe((projectState: ProjectStateModel) => {
                this.project = projectState.project;
                this._cd.markForCheck();
            });

        this.asCodeEditorSubscription = this._workflowCore.getAsCodeEditor()
            .subscribe((state) => {
                if (state != null) {
                    this.asCodeEditorOpen = state.open;
                    this._cd.markForCheck();
                }
            });

        this.qpRouteSubscription = this._activatedRoute.queryParams.subscribe(qps => {
            if (qps['node_id']) {
                this.selectedNodeID = Number(qps['node_id']);
                delete this.selectecHookRef;
            }
            if (qps['node_ref']) {
                this.selectedNodeRef = qps['node_ref'];
                delete this.selectecHookRef;
            }
            if (qps['hook_ref']) {
                this.selectecHookRef = qps['hook_ref'];
                delete this.selectedNodeRef;
                delete this.selectedNodeID;
            }
            this._cd.markForCheck();
        });

        this._store.dispatch(new CleanWorkflowState());
        this.workflowSubscription = this._store.select(WorkflowState.getCurrent()).subscribe( (s: WorkflowStateModel) => {
            this.sidebarMode = s.sidebar;
            this.editWorkflow = s.editWorkflow;
            if (s.modalSaveAsCode) {
                this.saveAsCodeModal();
            }


            if (s.workflow && (!this.workflow || (this.workflow && s.workflow.id !== this.workflow.id))) {
                this.workflow = s.workflow;
                this.initRuns(s.projectKey, s.workflow.name, s.filters);
            }
            if (s.workflow) {
                this.workflow = s.workflow;
                if (this.selectecHookRef) {
                    let h = Workflow.getHookByRef(this.selectecHookRef, this.workflow);
                    if (h) {
                        this._store.dispatch(new SelectHook({hook: h, node: this.workflow.workflow_data.node}));
                    }
                }
            }
            if (s.workflowRun) {
                this.workflowRun = s.workflowRun;
            } else {
                delete this.workflowRun;
            }
            this._cd.markForCheck();
        });


        // Workflow subscription
        this.paramsRouteSubscription = this._activatedRoute.params.subscribe(params => {
            let workflowName = params['workflowName'];
            let key = params['key'];

            if (key && workflowName) {
                this.loading = true;
                this._store.dispatch(new GetWorkflow({ projectKey: key, workflowName }))
                    .pipe(finalize(() => this.loading = false))
                    .subscribe(null, () => this._router.navigate(['/project', key]));
            }
        });

        // unselect all when returning on workflow main page
        this.eventsRouteSubscription = this._router.events.subscribe(e => {
            if (e instanceof NavigationStart && this.workflow) {
                if (e.url.indexOf('/project/' + this.project.key + '/workflow/') === 0 && e.url.indexOf('/run/') === -1) {
                    this._store.dispatch(new CleanWorkflowRun({}));
                }
            }
        });
    }

    initRuns(key: string, workflowName: string, filters?: {}): void {
        this._store.dispatch(
            new GetWorkflowRuns({projectKey: key, workflowName: workflowName, limit: '50', offset: '0', filters})
        );
    }

    updateFav() {
        if (this.loading || !this.workflow) {
            return;
        }
        this.loadingFav = true;
        this._store.dispatch(new UpdateFavoriteWorkflow({
            projectKey: this.project.key,
            workflowName: this.workflow.name
        })).pipe(finalize(() => this.loadingFav = false))
            .subscribe(() => this._toast.success('', this._translate.instant('common_favorites_updated')))
    }

    changeToRunsMode(): void {
        this._store.dispatch(new SidebarRunsMode({}));
    }

    showTemplateFrom(): void {
        if (this.templateApplyModal) {
            this.templateApplyModal.show();
        }
    }

    initTemplateFromWorkflow(): void {
        this._router.navigate(['settings', 'workflow-template', 'add'], {
            queryParams: {
                from: this.project.key + '/' + this.workflow.name,
            }
        });
    }

    saveAsCodeModal(): void {
        if (this.saveAsCode) {
            this.saveAsCode.show(this.editWorkflow, 'workflow');
        }
    }

    resyncPR(): void {
        this.loadingPopupButton = true;
        this._ascodeService.resyncPRAsCode(this.project.key,
            this.workflow.applications[this.workflow.workflow_data.node.context.application_id].name,
            this.workflow.from_repository)
            .pipe(finalize(() => this.loadingPopupButton = false))
            .subscribe(() => {
                this.popupFromlRepository.close();
            });
    }
}
