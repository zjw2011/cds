import { registerLocaleData } from '@angular/common';
import localeEN from '@angular/common/locales/en';
import localeFR from '@angular/common/locales/fr';
import { Component, NgZone, OnInit } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, NavigationEnd, ResolveEnd, ResolveStart, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Store } from '@ngxs/store';
import { WebSocketMessage } from 'app/model/websocket.model';
import { Observable } from 'rxjs';
import { delay, filter, map, mergeMap, retryWhen } from 'rxjs/operators';
import { Subscription } from 'rxjs/Subscription';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import * as format from 'string-format-obj';
import { AppService } from './app.service';
import { LanguageStore } from './service/language/language.store';
import { NotificationService } from './service/notification/notification.service';
import { ThemeStore } from './service/theme/theme.store';
import { AutoUnsubscribe } from './shared/decorator/autoUnsubscribe';
import { ToastService } from './shared/toast/ToastService';
import { CDSWebWorker } from './shared/worker/web.worker';
import { CDSWorker } from './shared/worker/worker';
import { AuthenticationState } from './store/authentication.state';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.scss']
})
@AutoUnsubscribe()
export class AppComponent implements OnInit {
    open: boolean;
    isConnected = false;
    versionWorker: CDSWebWorker;
    sseWorker: CDSWorker;
    zone: NgZone;
    currentVersion = 0;
    showUIUpdatedBanner = false;
    languageSubscriber: Subscription;
    themeSubscriber: Subscription;
    versionWorkerSubscription: Subscription;
    _routerSubscription: Subscription;
    _routerNavEndSubscription: Subscription;
    displayResolver = false;
    toasterConfig: any;
    previousURL: string;

    websocket: WebSocketSubject<any>;

    constructor(
        _translate: TranslateService,
        private _language: LanguageStore,
        private _theme: ThemeStore,
        private _activatedRoute: ActivatedRoute,
        private _titleService: Title,
        private _router: Router,
        private _notification: NotificationService,
        private _appService: AppService,
        private _toastService: ToastService,
        private _store: Store
    ) {
        this.zone = new NgZone({ enableLongStackTrace: false });
        this.toasterConfig = this._toastService.getConfig();
        _translate.addLangs(['en', 'fr']);
        _translate.setDefaultLang('en');
        let browserLang = navigator.language.match(/fr/) ? 'fr' : 'en';
        _translate.use(browserLang.match(/en|fr/) ? browserLang : 'en');
        registerLocaleData(browserLang.match(/fr/) ? localeFR : localeEN);

        this.languageSubscriber = this._language.get().subscribe(l => {
            if (l) {
                _translate.use(l);
            } else {
                _language.set(browserLang.match(/en|fr/) ? browserLang : 'en');
            }
        });

        this.themeSubscriber = this._theme.get().subscribe(t => {
            if (t) {
                document.body.className = t;
            } else {
                _theme.set('light');
            }
        });

        this._notification.requestPermission();
    }

    ngOnInit(): void {
        this._store.select(AuthenticationState.user).subscribe(user => {
            if (!user) {
                this.isConnected = false;
                this.stopWorker(this.sseWorker, null);
            } else {
                this.isConnected = true;
                this.startWebSocket();
            }
            this.startVersionWorker();
        });

        this._routerSubscription = this._router.events
            .pipe(filter((event) => event instanceof ResolveStart || event instanceof ResolveEnd))
            .subscribe(e => {
                if (e instanceof ResolveStart) {
                    this.displayResolver = true;
                }
                if (e instanceof ResolveEnd) {
                    this.displayResolver = false;
                }
            });

        this._routerNavEndSubscription = this._router.events
            .pipe(filter((event) => event instanceof NavigationEnd))
            .pipe(map((e: NavigationEnd) => {
                if (!this.previousURL || this.previousURL.split('?')[0] !== e.url.split('?')[0]) {
                    this.previousURL = e.url;
                    this.manageWebsocketFilterByUrl(e.url);
                    return;
                }

            }))
            .pipe(map(() => this._activatedRoute))
            .pipe(map((route) => {
                let params = {};
                while (route.firstChild) {
                    route = route.firstChild;
                    Object.assign(params, route.snapshot.params, route.snapshot.queryParams);
                }
                this._appService.updateRoute(params);
                return { route, params: Observable.of(params) };
            }))
            .pipe(filter((event) => event.route.outlet === 'primary'))
            .pipe(mergeMap((event) => Observable.zip(event.route.data, event.params)))
            .subscribe((routeData) => {
                if (!Array.isArray(routeData) || routeData.length < 2) {
                    return;
                }
                if (routeData[0]['title']) {
                    let title = format(routeData[0]['title'], routeData[1]);
                    this._titleService.setTitle(title);
                } else {
                    this._titleService.setTitle('CDS');
                }
            });
    }

    manageWebsocketFilterByUrl(url: string) {
        let msg =  new WebSocketMessage();
        let urlSplitted = url.substr(1, url.length - 1).split('/');
        switch (urlSplitted[0]) {
            case 'home':
                msg.favorites = true;
                break;
            case 'project':
                switch (urlSplitted.length) {
                    case 1: // project creation
                        break;
                    case 2: // project view
                        msg.project_key = urlSplitted[1].split('?')[0];
                        break;
                    default: // App/pipeline/env/workflow view
                        msg.project_key = urlSplitted[1].split('?')[0];
                        this.manageWebsocketFilterProjectPath(urlSplitted, msg);
                }
        }
        this.websocket.next(msg);
    }

    manageWebsocketFilterProjectPath(urlSplitted: Array<string>, msg: WebSocketMessage) {
        switch (urlSplitted[2]) {
            case 'pipeline':
                if (urlSplitted.length >= 4) {
                    msg.pipeline_name = urlSplitted[3].split('?')[0];
                }
                break;
            case 'application':
                if (urlSplitted.length >= 4) {
                    msg.application_name = urlSplitted[3].split('?')[0];
                }
                break;
            case 'environment':
                if (urlSplitted.length >= 4) {
                    msg.environment_name = urlSplitted[3].split('?')[0];
                }
                break;
            case 'workflow':
                if (urlSplitted.length >= 4) {
                    msg.workflow_name = urlSplitted[3].split('?')[0];
                }
                if (urlSplitted.length >= 6) {
                    msg.workflow_run_num = Number(urlSplitted[5].split('?')[0]);
                }
                if (urlSplitted.length >= 8) {
                    msg.workflow_node_run_id = Number(urlSplitted[7].split('?')[0]);
                }
                break;
        }
    }

    stopWorker(w: CDSWorker, s: Subscription): void {
        if (w) {
            w.stop();
        }
        if (s) {
            s.unsubscribe();
        }
    }

    startWebSocket(): void {
        const protocol = window.location.protocol.replace('http', 'ws');
        const host = window.location.host;
        const href = this._router['location']._baseHref;

        this.websocket = webSocket(`${protocol}//${host}${href}/cdsapi/ws`);
        this.websocket.pipe(retryWhen(errors => errors.pipe(delay(5000)))).subscribe((message) => {
            this._appService.manageEvent(message);
        }, (err) => {
            console.error('Error: ', err)
        }, () => {
            console.warn('Websocket Completed');
        });
    }

    startVersionWorker(): void {
        this.stopWorker(this.versionWorker, this.versionWorkerSubscription);
        this.versionWorker = new CDSWebWorker('./assets/worker/web/version.js');
        this.versionWorker.start({});
        this.versionWorker.response().subscribe(msg => {
            if (msg) {
                this.zone.run(() => {
                    let versionJSON = Number(JSON.parse(msg).version);
                    if (this.currentVersion === 0) {
                        this.currentVersion = versionJSON;
                    }
                    if (this.currentVersion < versionJSON) {
                        this.showUIUpdatedBanner = true;
                    }
                });
            }
        });
    }

    refresh(): void {
        this.zone.runOutsideAngular(() => {
            location.reload(true);
        });
    }
}
