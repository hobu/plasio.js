// mode-manager.js
// Based on what the user is doing in the scene, this class manages
// which modes are active and which ones aren't.  Provides hooks which
// can then be called through user menus etc.
//

import { getxy, getxyScreen, pickUIPoint } from "./util";
import { OrbitalCamera } from "./cameras/orbital";
import { PointPicker } from "./modes/point-picker";
import { LinePicker } from "./modes/line-picker";

/**
 * The mode manager class which manages several modes our UI interaction could be in.
 */
export class ModeManager {
    constructor(element, renderer, geoTransform,
                appConfig, viewChangedFn, defaultCameraParams) {
        this.e = element;
        this.r = renderer;
        this.geoTransform = geoTransform;
        this.appc = appConfig;

        this.currentMode = null; // what mode we're in right now?
        this.dragging = false;   // are we dragging?
        this.active = null;      // which mode was active when the dragging was initiated
        this.lastHoveredEntity = null; // needed to generate mouse-enter and mouse-leave events
        this.lockedMode = null;
        this.actionListeners = [];

        // browser clicks are weird a little bit, even if you move our mouse great distances
        // it sends out a click, we want a synthetic click event which is only raised when
        // a the mouse isn't moved too much or the delay between clicks isn't too much
        //
        this.synthClickEventInfo = {};

        // Our camera, fallback for most actions
        this.camera = new OrbitalCamera(element, renderer,
            this.geoTransform, viewChangedFn, defaultCameraParams);

        // camera mode is the default current mode
        this.currentMode = this.camera;

        // All the entity modes we handle for now
        this.entityManagers = {
            "point": new PointPicker(this, element, renderer),
            "line": new LinePicker(this, element, renderer)
        };

        let entityToManager = entity => {
            if (entity)
                return this.entityManagers[entity.type];
        };

        this.mouseMoveHandler = e => {
            e.preventDefault();

            let localSpace = getxy(e);
            let screenSpace = getxyScreen(e);

            if (this.lockedMode) {
                // when a mode lock is in progress, then just emit standard
                // mouse moves
                //
                return this.lockedMode.invokeHandler("mouse-move", {
                    event: e,
                    pos: localSpace,
                    screenPos: screenSpace
                });
            }

            if (this.dragging) {
                // We are dragging so ignore all the default stuff and just update the
                // mode we're updating
                if (this.active) {
                    this.active.owner.invokeHandler("dragging", {
                        event: e,
                        entity: this.active.entity,
                        pos: localSpace,
                        screenPos: screenSpace
                    });
                }
            }
            else {
                let entity = pickUIPoint(renderer, localSpace);

                if (!this.isSameEntity(entity, this.lastHoveredEntity)) {
                    // the last hovered entity changed, do the eventing for mouse enter/leave
                    if (this.lastHoveredEntity) {
                        let manager = entityToManager(this.lastHoveredEntity);
                        if (manager) manager.invokeHandler("mouse-leave", {
                            event: e,
                            entity: this.lastHoveredEntity,
                            pos: localSpace,
                            screenPos: screenSpace
                        });
                    }
                    // Invoke the handler on the next hovered entity
                    this.lastHoveredEntity = entity;
                    if (this.lastHoveredEntity) {
                        let manager = entityToManager(this.lastHoveredEntity);
                        if (manager) manager.invokeHandler("mouse-enter", {
                            event: e,
                            entity: this.lastHoveredEntity,
                            pos: localSpace,
                            screenPos: screenSpace
                        });
                    }
                }
            }
        };

        this.mouseUpHandler = e => {
            // The mouse was released, just send down the event to our active entity
            let localSpace = getxy(e);
            let screenSpace = getxyScreen(e);
            if (this.lockedMode) {
                return this.lockedMode.invokeHandler("mouse-up", {
                    event: e,
                    pos: localSpace,
                    screenPos: screenSpace
                });
            }

            if(this.active) {
                this.active.owner.invokeHandler("mouse-up", {
                    event: e,
                    entity: this.active.entity
                });


                // do we need to dispatch synthetic event?
                if (this.synthClickEventInfo != null) {
                    let ts = this.synthClickEventInfo.ts,
                        loc = this.synthClickEventInfo.pos;

                    var dist = vec2.dist(loc, screenSpace),
                        delay = Date.now() - ts;

                    // After long and arduous user study spanning over
                    // long periods of time and costing thousands of dollars these
                    // thresholds were determined.
                    //
                    if (dist < 5 && delay < 500) {
                        // we need to invoke synthetic click
                        //
                        this.active.owner.invokeHandler("synthetic-click", {
                            pos: localSpace,
                            screenPos: screenSpace
                        });
                    }

                    this.synthClickEventInfo = {};
                }
                    
                

                this.active = null;
            }

            this.dragging = false;

            // remove handlers
            document.removeEventListener("mousemove", this.mouseMoveHandler);
            document.removeEventListener("mouseup", this.mouseUpHandler);
        };

        this.mouseDownHandler = e => {
            // if we clicked on an entity, we need to trigger the action on that
            // particular mode
            e.preventDefault();

            let localSpace = getxy(e);
            let screenSpace = getxyScreen(e);

            // if there is a mode lock active, then just send raw event down to the
            // locked mode
            if (this.lockedMode) {
                return this.lockedMode.invokeHandler("mouse-down", {
                    event: e,
                    pos: localSpace,
                    screenPos: screenSpace
                });
            }

            let entity = pickUIPoint(renderer, localSpace);
            let entityManager = entityToManager(entity);

            // The mouse button could've come down on an entity, which means that the entity
            // would need to be notified that it was invoked because one of its components were
            // clicked on
            if (entityManager) {
                this.active = {
                    owner: entityManager,
                    entity: entity
                };

                // tell the owner that it was invoked because one of its entities were clicked on
                entityManager.invokeHandler("mouse-down-on-entity", {
                    event: e,
                    entity: entity,
                    pos: localSpace,
                    screenPos: screenSpace
                });
            }
            else {
                // Nothing was clicked, so pass down the control to the current mode
                this.active = { owner: this.currentMode };
                this.currentMode.invokeHandler("mouse-down", {
                    event: e,
                    pos: localSpace,
                    screenPos: screenSpace
                });

                // store any synthetic click event information
                this.synthClickEventInfo = {
                    pos: screenSpace,
                    ts: Date.now()
                };
            }

            // If the user engaged a lock in this mouse down handler, we'd never see the mouse up event
            // (since the locked mode will get it), this means that we cannot initiate dragging mode
            if (!this.lockedMode) {
                // no lock mode was engaged, so we'd drag as usual
                this.dragging = true;
            }

            // attach the handlers to the document so that scope is global
            document.addEventListener("mousemove", this.mouseMoveHandler, true);
            document.addEventListener("mouseup", this.mouseUpHandler, true);
        };

        let eventDispatcher = (eventName) => {
            // if the active entity doesn't have a handler for the given event, propagate it to
            // the current active mode
            return e => {
                e.preventDefault();

                let localSpace = getxy(e);
                let screenSpace = getxyScreen(e);
                let entity = pickUIPoint(renderer, localSpace);
                let entityManager = entityToManager(entity);

                if (this.lockedMode) {
                    return this.lockedMode.invokeHandler(eventName, {
                        event: e,
                        pos: localSpace,
                        screenPos: screenSpace
                    });
                }

                let hasHandler = false;

                if (entityManager) {
                    hasHandler = entityManager.hasHandler(eventName);
                }

                if (hasHandler) {
                    entityManager.invokeHandler(eventName, {
                        event: e,
                        entity: entity,
                        pos: localSpace,
                        screenPos: screenSpace
                    });
                }
                else {
                    this.currentMode.invokeHandler(eventName, {
                        event: e,
                        pos: localSpace,
                        screenPos: screenSpace
                    });
                }
            }
        };

        this.doubleClickHandler = eventDispatcher("double-click");
        this.clickHandler = eventDispatcher("click");
        this.mouseWheelHandler = eventDispatcher("mouse-wheel");

        this.contextMenuHandler = e => {
            // the context menu handler works slightly differently, if there's a handler
            // available, the handler can return a list of actions to perform on the particular
            // context, these actions are passed down to the user of ModeManager for appropriate
            // display/action
            e.preventDefault();

            let localSpace = getxy(e);
            let screenSpace = getxyScreen(e);
            let entity = pickUIPoint(renderer, localSpace);
            let entityManager = entityToManager(entity);

            if (this.lockedMode) {
                // no context menu actions when a lock is on
                return;
            }

            let actions = null;
            if (entityManager) {
                actions = entityManager.invokeHandler("context-menu-on-entity", {
                    event: e,
                    entity: entity,
                    pos: localSpace,
                    screenPos: screenSpace
                });
            }
            else {
                // see if our current mode wants to override it
                actions = this.currentMode.invokeHandler("context-menu", {
                    event: e,
                    pos: localSpace,
                    screenPos: screenSpace
                });
            }

            // even if there are no actions available, we want to make sure we notify
            // our action listeners that that user attempted to see the actions
            //
            if (this.actionListeners.length > 0) {
                let acts = actions || {};
                // the context menu returned some actions, propagate these to the owner

                this.actionListeners.forEach(f => {
                    f.call(this, acts, {
                        pos: localSpace,
                        screenPos: screenSpace
                    });
                });
            }
        };

        let e = element ? element : document;

        e.addEventListener("mousedown", this.mouseDownHandler);
        e.addEventListener("dblclick", this.doubleClickHandler);
        e.addEventListener("click", this.clickHandler);
        e.addEventListener("contextmenu", this.contextMenuHandler);
        e.addEventListener("mousewheel", this.mouseWheelHandler);
        e.addEventListener("DOMMouseScroll", this.mouseWheelHandler);
    }

    get activeCamera() {
        return this.camera;
    }

    get applicationConfig() {
        return this.appc;
    }

    set activeMode(newMode) {
        // set the active mode for the mode manager, setting new mode as null is the
        // same as setting it to camera.
        if (!newMode || newMode === "camera") {
            this.currentMode = this.camera;
        }
        else {
            let mode = this.entityManagers[newMode];
            if (!mode)
                throw new Error("Don't recognize the mode you're trying to set: " + newMode);

            this.currentMode = mode;
        }
    }

    addActionListener(f) {
        this.actionListeners.push(f);
    }

    isSameEntity(a, b) {
        // rules for equivalence:
        // 1. Both entities are null
        // 2. Both entities have the same entity type and their manager says they are equivalent
        //

        // some shortpaths, two entityes
        if (a === null && b === null) {
            // both null
            return true;
        }
        else if ((a === null && b !== null) ||
            (b === null && a !== null)) {
            // one of them null
            return false;
        }
        else if (a.type === b.type) {
            // the types are the same, which means that we delegate the equivalence test to the manager
            let manager = this.entityManagers[a.type];
            if (!manager)
                return false; // no manager
            return manager.isSameEntity(a, b);
        }

        return false;
    }

    propagateDataRangeHint(rx, ry, rz) {
        // propagate to all our modes
        const hint = {
            rx: rx,
            ry: ry,
            rz: rz
        };

        const toInvoke = Object.values(this.entityManagers).concat([this.camera]);

        toInvoke.forEach(v => {
            v.invokeHandler("hint-data-range", hint);
        });
    }

    lockMode() {
        this.lockedMode = this.currentMode;

        console.log("mode manager lock is ON", this.lockedMode);
    }

    unlockMode() {
        console.log("mode manager lock is OFF", this.lockedMode);

        this.lockedMode = null;
    }
}
