import * as cytoscape from 'cytoscape';
import { NodeSingular } from 'cytoscape';

export interface CytoscapeEvent {
    cy: cytoscape.Core;
    target: NodeSingular;
}

export class CytoscapeHtmlContainer {
    cy: cytoscape.Core;
    htmlContainer: HTMLDivElement;
    children: {[key: string]: HTMLElement};

    constructor(c: cytoscape.Core) {
        this.cy = c;
        this.children = {};
        this.init();
    }

    init(): void {
        // Create div container
        this.htmlContainer = document.createElement('div');
        let stl = this.htmlContainer.style;
        stl.position = 'absolute';
        stl['z-index'] = 10;
        stl.width = '500px';
        stl['pointer-events'] = 'none';

        // Add container
        this.cy.container().childNodes.item(0).appendChild(this.htmlContainer);
    }

    refreshData(cy: cytoscape.Core): void {
        cy.nodes().forEach( n => {
            this.refreshElement(n);
        });
    }

    refreshView(cy: cytoscape.Core): void {
        const val = `translate(${cy.pan().x}px,${cy.pan().y}px) scale(${cy.zoom()})`;
        const stl = <any>this.htmlContainer.style;
        const origin = "top left";
        stl.webkitTransform = val;
        stl.msTransform = val;
        stl.transform = val;
        stl.webkitTransformOrigin = origin;
        stl.msTransformOrigin = origin;
        stl.transformOrigin = origin;
    }

    refreshElement(n: NodeSingular) {
        let cur = this.children[n.id()];
        if (cur) {
            cur.innerHTML = n.data('template');
        } else {
            // Create div container
            let container = document.createElement('div');
            container.innerHTML = n.data('template');
            container.style.width = '180px';
            container.style.height = '60px';
            container.style.position = 'absolute';
            this.htmlContainer.appendChild(container);
            this.children[n.id()] = container;
        }
    }
}
