// tslint:disable-next-line: max-line-length
import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ComponentFactoryResolver, ComponentRef, EventEmitter, HostListener, Input, Output, ViewChild, ViewContainerRef } from '@angular/core';
import { CytoscapeHtmlContainer } from 'app/model/cytoscape.model';
import { Project } from 'app/model/project.model';
import { WNode, Workflow } from 'app/model/workflow.model';
import { WorkflowCoreService } from 'app/service/workflow/workflow.core.service';
import { WorkflowStore } from 'app/service/workflow/workflow.store';
import { AutoUnsubscribe } from 'app/shared/decorator/autoUnsubscribe';
import { WorkflowWNodeMenuEditComponent } from 'app/shared/workflow/menu/edit-node/menu.edit.node.component';
import { WorkflowNodeHookComponent } from 'app/shared/workflow/wnode/hook/hook.component';
import { WorkflowWNodeComponent } from 'app/shared/workflow/wnode/wnode.component';
import * as cytoscape from 'cytoscape';
import { ElementsDefinition, Stylesheet } from 'cytoscape';
import * as cytodagre from 'cytoscape-dagre';
import * as d3 from 'd3';
import * as dagreD3 from 'dagre-d3';

@Component({
    selector: 'app-workflow-graph',
    templateUrl: './workflow.graph.html',
    styleUrls: ['./workflow.graph.scss'],
    entryComponents: [
        WorkflowWNodeComponent,
        WorkflowNodeHookComponent
    ],
    changeDetection: ChangeDetectionStrategy.OnPush
})
@AutoUnsubscribe()
export class WorkflowGraphComponent implements AfterViewInit {
    static margin = 80; // let 40px on top and bottom of the graph
    static maxScale = 1.6;
    static minScale = 0.45;
    static maxOriginScale = 1;

    cy: cytoscape.Core;
    htmlContainer: CytoscapeHtmlContainer;

    workflow: Workflow;
    @Input('workflowData')
    set workflowData(data: Workflow) {
        this.workflow = data;
        this.nodesComponent = new Map<string, ComponentRef<WorkflowWNodeComponent>>();
        this.hooksComponent = new Map<string, ComponentRef<WorkflowNodeHookComponent>>();
    }
    selectedNode: WNode;

    @Input() project: Project;

    @Input('direction')
    set direction(data: string) {
        this._direction = data;
        this._workflowStore.setDirection(this.project.key, this.workflow.name, this.direction);
    }
    get direction() { return this._direction; }

    @Output() deleteJoinSrcEvent = new EventEmitter<{ source: any, target: any }>();

    ready: boolean;
    _direction: string;

    // workflow graph
    @ViewChild('nodeMenu', {static: false}) nodeMenu: WorkflowWNodeMenuEditComponent;
    @ViewChild('container', {read: ViewContainerRef, static: true}) container: ViewContainerRef;
    @ViewChild('svgGraph', { read: ViewContainerRef, static: false }) svgContainer: any;
    g: dagreD3.graphlib.Graph;
    render = new dagreD3.render();

    linkWithJoin = false;

    nodesComponent = new Map<string, ComponentRef<WorkflowWNodeComponent>>();
    hooksComponent = new Map<string, ComponentRef<WorkflowNodeHookComponent>>();

    zoom: d3.ZoomBehavior<Element, {}>;
    svg: any;

    constructor(
        private componentFactoryResolver: ComponentFactoryResolver,
        private _cd: ChangeDetectorRef,
        private _workflowStore: WorkflowStore,
        private _workflowCore: WorkflowCoreService,
    ) {
        cytoscape.use(cytodagre);
    }

    ngAfterViewInit(): void {
        this.ready = true;
        this.changeDisplay();
        this._cd.markForCheck();
    }

    changeDisplay(): void {
        if (!this.ready && this.workflow) {
            return;
        }
        this.initGraph();
    }

    initGraph() {
        if (!this.ready || !this.workflow) {
            return;
        }
        let dagreOpts = {
            name: 'dagre',
            // dagre algo options, uses default value on undefined
            nodeSep: 10, // the separation between adjacent nodes in the same rank
            edgeSep: 5, // the separation between adjacent edges in the same rank
            rankSep: 15, // the separation between each rank in the layout
            rankDir: 'LR', // 'TB' for top to bottom flow, 'LR' for left to right,
            ranker: undefined, // Type of algorithm to assign a rank to each node in the input graph. Possible values: 'network-simplex', 'tight-tree' or 'longest-path'
            minLen: function( edge ) { return 1; }, // number of ranks to keep between the source and target of the edge
            edgeWeight: function( edge ) { return 1; }, // higher weight edges are generally made shorter and straighter than lower weight edges

            // general layout options
            fit: true, // whether to fit to viewport
            padding: 30, // fit padding
            spacingFactor: undefined, // Applies a multiplicative factor (>0) to expand or compress the overall area that the nodes take up
            nodeDimensionsIncludeLabels: false, // whether labels should be included in determining the space used by a node
            animate: false, // whether to transition the node positions
            animateFilter: function( node, i ) { return true; }, // whether to animate specific nodes when animation is on; non-animated nodes immediately go to their final positions
            animationDuration: 500, // duration of animation in ms if enabled
            animationEasing: undefined, // easing of animation if enabled
            boundingBox: undefined, // constrain layout bounds; { x1, y1, x2, y2 } or { x1, y1, w, h }
            transform: function( node, pos ) { return pos; }, // a function that applies a transform to the final node position
            ready: function() {}, // on layoutready
            stop: function() {} // on layoutstop
        };



        let style = <Stylesheet[]>[ // the stylesheet for the graph
            {
                selector: 'node',
                style: {
                    'background-opacity': '0',
                    'border-width': 1,
                    'border-color': 'grey',
                    'width': '180px',
                    'height': '60px',
                    'shape': 'rectangle',

                    'label': 'data(label)',
                    'label-width': '180px',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'text-justification': 'left',
                    'line-height': '1.2px',
                    'text-wrap': 'wrap',
                    'cursor': 'pointer'
                }
            },

            {
                selector: 'edge',
                style: {
                    'width': 3,
                    'line-color': '#ccc',
                    'target-arrow-color': '#ccc',
                    'target-arrow-shape': 'triangle'
                }
            }
        ];

        let elements = <ElementsDefinition>{
            nodes: [],
            edges: []
        };
        let nodes = Workflow.getAllNodes(this.workflow);
        nodes.forEach( n => {
            elements.nodes.push({
                data: { id: n.id.toString(), node: n, template: '<b>Coucou</b>', label: 'pipeline\napplication\nenvironment'}
            });

            if (n.triggers) {
                n.triggers.forEach(t => {
                    elements.edges.push({
                        data: { id: t.id.toString(), source: n.id.toString(), target: t.child_node.id.toString() }
                    });
                });
            }
            if (n.parents) {
                n.parents.forEach(p => {
                    elements.edges.push({
                        data: { id: p.id.toString(), source: p.parent_id.toString(), target: n.id.toString() }
                    });
                });
            }
        });

        this.cy = cytoscape({
            container: this.container.element.nativeElement,
            minZoom: WorkflowGraphComponent.minScale,
            maxZoom: WorkflowGraphComponent.maxScale,
            style: style,
            layout: dagreOpts, // options,//dagreOpts,
            elements: elements
        });
        this.cy.on('pan zoom', (event: any) => {
            // console.log(event);
        });
        this.cy.on('tap', () => {
        });
        this.cy.on('tap', 'node', (event) => {
            console.log(event);
            this.selectedNode = this.workflow.workflow_data.node;
            this.nodeMenu.show(this.project, this.workflow.workflow_data.node, false, event.originalEvent.clientX, event.originalEvent.clientY);
            // this.popup.popup.config.placement = '';
                // this.popup.open();
                // this.popup._componentRef.location.nativeElement.childNodes[0].style.left = '500px';
                // var cssDeclaration = <CSSStyleDeclaration>this.popup._componentRef.location.nativeElement.childNodes[0].style;
                // cssDeclaration.setProperty('left', '500px');
                // cssDeclaration.setProperty('top', '300px');
                // console.log(this.popup);
                // console.log(event.target.position('y'));
                // console.log(event.target.position('x'));
                // console.log(this.popup);
                // this.popup.popup.elementRef.nativeElement.style.position = 'absolute';
                // this.popup.popup.elementRef.nativeElement.style.top = event.target.position('y');
                // this.popup.popup.elementRef.nativeElement.style.left = event.target.position('x');
                // console.log(this.popup._componentRef.location.nativeElement.childNodes[0].style);
                // console.log(this.popup.template.elementRef.nativeElement);
                // console.log(this.popup.template.elementRef);


            /*
            this.popup.open();
            console.log(this.popup.template.elementRef.nativeElement.style);
            console.log(this.popup.template.elementRef.nativeElement);
            console.log(this.popup.template.elementRef);
            this.popup.template.elementRef.nativeElement.style['position'] = 'absolute';
            this.popup.template.elementRef.nativeElement.style.top = event.target.position('y');
            this.popup.template.elementRef.nativeElement.style.left = event.target.position('x');
            console.log(event.target.data('template'));
            console.log(this.popup);
            console.log(this.popup.template.elementRef.nativeElement);
            */

        });
        /*
        if (!this.htmlContainer) {
            this.htmlContainer = new CytoscapeHtmlContainer(this.cy);
            this.cy.one("render", (event: CytoscapeEvent) => {
                this.htmlContainer.refreshData(event.cy);
                this.htmlContainer.refreshView(event.cy);
            });
            this.cy.on("pan zoom", (event: CytoscapeEvent) => {
                this.htmlContainer.refreshView(event.cy);
            });
            this.cy.on('tap', 'node', (event: CytoscapeEvent) => {
                console.log(event.target.data('template'));
            });
        }

         */

    }

    receivedEvent(e) {
        console.log(e);
    }

    clickOrigin() {
        let w = this.svgContainer.element.nativeElement.width.baseVal.value - WorkflowGraphComponent.margin;
        let h = this.svgContainer.element.nativeElement.height.baseVal.value - WorkflowGraphComponent.margin;
        let gw = this.g.graph().width;
        let gh = this.g.graph().height;
        let oScale = Math.min(w / gw, h / gh); // calculate optimal scale for current graph
        // calculate final scale that fit min and max scale values
        let scale = Math.min(
            WorkflowGraphComponent.maxOriginScale,
            Math.max(WorkflowGraphComponent.minScale, oScale)
        );
        let centerX = (w - gw * scale + WorkflowGraphComponent.margin) / 2;
        let centerY = (h - gh * scale + WorkflowGraphComponent.margin) / 2;
        this.svg.call(this.zoom.transform, d3.zoomIdentity.translate(centerX, centerY).scale(scale));
    }


    @HostListener('document:keydown', ['$event'])
    handleKeyboardEvent(event: KeyboardEvent) {
        if (event.code === 'Escape' && this.linkWithJoin) {
            this._workflowCore.linkJoinEvent(null);
        }
    }

}
