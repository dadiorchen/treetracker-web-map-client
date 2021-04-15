/*
 * The main model for the treetracker model
 */
import  log from "loglevel";
import expect from "expect-runtime";
import Requester from "./Requester";
import {getInitialBounds} from "../mapTools";
import {mapConfig} from "../mapConfig";
import axios from "axios";

export default class Map{

  constructor(options){

    //default
    options = {...{
      L: window.L,
      minZoom: 2,
      maxZoom: 20,
      initialCenter: [20, 0],
      tileServerUrl: process.env.REACT_APP_TILE_SERVER_URL,
      apiServerUrl: process.env.REACT_APP_API,
      width: window.innerWidth,
      height: window.innerHeight,
      debug: true,
      moreEffect: false,
      filters: {},
    }, ...options};

    Object.keys(options).forEach(key => {
      this[key] = options[key];
    });
    //log.warn("options:", options);

    //requester
    this.requester = new Requester();
    //request nearest trees
    this.requesterNearest = new Requester();
  }

  /***************************** static ****************************/
  static formatClusterText(count){
    if(count > 1000){
      return `${Math.round(count/1000)}K`;
    }else{
      return count;
    }
  }
  static getClusterRadius(zoom) {
    switch (zoom) {
      case 1:
        return 10;
      case 2:
        return 8;
      case 3:
        return 6;
      case 4:
        return 4;
      case 5:
        return 0.8;
      case 6:
        return 0.75;
      case 7:
        return 0.3;
      case 8:
        return 0.099;
      case 9:
        return 0.095;
      case 10:
        return 0.05;
      case 11:
        return 0.03;
      case 12:
        return 0.02;
      case 13:
        return 0.008;
      case 14:
        return 0.005;
      case 15:
        return 0.004;
      case 16:
        return 0.003;
      case 17:
      case 18:
      case 19:
        return 0.0;
      default:
        return 0;
    }
  }

  static parseUtfData(utfData){
    const [lon, lat] = JSON.parse(utfData.latlon).coordinates;
    const data = {
      ...utfData,
      lat,
      lon,
    };
    return data;
  }

  /***************************** methods ***************************/

  async mount(domElement){
    const mapOptions = {
      minZoom: this.minZoom,
      center: this.initialCenter,
      zoomControl: false,
    }
    this.map = this.L.map(domElement, mapOptions);

    //control
    this.control = this.L.control.zoom({
        position: 'bottomright'
    });
    this.control.addTo(this.map);
    this.map.setView(this.initialCenter, this.minZoom);

    //load google map
    await this.loadGoogleSatellite();

    /*
     * The logic is:
     * If there is a filter, then try to zoom in and set the zoom is
     * appropriate for the filter, then load the tile.
     * But if there is a bounds ( maybe the browser was refreshed or jump
     * to the map by a shared link), then jump the bounds directly, 
     * regardless of the initial view for filter.
     */
    if(this.filters.bounds){
      await this.gotoBounds(this.filters.bounds);
    }else{
      await this.loadInitialView();
    }

    //fire load event
    this.onLoad && this.onLoad();

    //load tile
    if(this.filters.treeid){
      log.info("treeid mode do not need tile server");
    }else{
      await this.loadTileServer();
    }

    //mount event
    this.map.on("moveend", e => {
      log.warn("move end", e);
      this.updateUrl();
    });


    if(this.filters.treeid){
      await this.loadTree(this.filters.treeid);
    }

    //load freetown special map
    await this.loadFreetownLayer();

    await this.loadDebugLayer();
  }

  async loadGoogleSatellite(){
    log.warn("load google satellite map");
    this.layerGoogle = this.L.tileLayer(
      'http://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}',{
        maxZoom: this.maxZoom,
        //attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
        //'Imagery © <a href="https://www.mapbox.com/">Mapbox</a>',
        subdomains:['mt0','mt1','mt2','mt3']
      });
    this.layerGoogle.addTo(this.map);
    await new Promise((res, _rej) => {
      this.layerGoogle.once("load", async () => {
        log.warn("google layer loaded");
        res();
      });
    });
  }

  async gotoBounds(bounds){
    const [southWestLng, southWestLat, northEastLng, northEastLat] = 
      bounds.split(",");
    log.warn("go to bounds:", bounds);
    if(this.moreEffect){
      this.map.flyToBounds([
        [southWestLat, southWestLng],
        [northEastLat, northEastLng]
      ]);
      log.warn("waiting bound load...");
      await new Promise((res, _rej) => {
        const boundFinished = () => {
          log.warn("fire bound finished");
          this.map.off("moveend");
          res();
        }
        this.map.on("moveend", boundFinished);
      });
    }else{
      this.map.fitBounds([
        [southWestLat, southWestLng],
        [northEastLat, northEastLng]
      ], {animate: false});
      //no effect, return directly
    }
  }

  async loadTileServer(){
    //tile 
    const filterParameters = this.getFilterParameters();
    this.layerTile = new this.L.tileLayer(
      `${this.tileServerUrl}{z}/{x}/{y}.png${filterParameters && "?" + filterParameters}`,
      {
        minZoom: this.minZoom,
        maxZoom: this.maxZoom,
        //close to avoid too many requests
        updateWhenZooming: true,
        updateWhenIdle: true,
      }
    );
    this.layerTile.addTo(this.map);

    this.layerUtfGrid = new this.L.utfGrid(
      `${this.tileServerUrl}{z}/{x}/{y}.grid.json${filterParameters && "?" + filterParameters}`,
      {
        minZoom: this.minZoom,
        maxZoom: this.maxZoom,
        //close to avoid too many requests
        updateWhenZooming: false,
        updateWhenIdle: false,
      }
    );
    this.layerUtfGrid.on('click', (e) => {
      log.warn("click:", e);
      if (e.data) {
        this.clickMarker(Map.parseUtfData(e.data));
      }
    });

    this.layerUtfGrid.on('mouseover', (e) => {
      log.debug("mouseover:", e);
      this.highlightMarker(Map.parseUtfData(e.data));
    });

    this.layerUtfGrid.on('mouseout', (e) => {
      log.debug("e:", e);
      this.unHighlightMarker();
    });

    this.layerUtfGrid.on("load", (e) => {
      log.info("all grid loaded");
      this.checkArrow();
    });

    this.layerUtfGrid.on("tileunload", (e) => {
      log.warn("tile unload:", e);
      e.tile.cancelRequest();
    });

    this.layerUtfGrid.on("tileloadstart", (e) => {
      //log.warn("tile tileloadstart:", e);
    });

    this.layerUtfGrid.on("tileload", (e) => {
      //log.warn("tile load:", e);
    });

    this.layerUtfGrid.addTo(this.map);

    //bind the finding marker function
    this.layerUtfGrid.hasMarkerInCurrentView = () => {
      //waiting layer is ready
      let isLoading = this.layerUtfGrid.isLoading();
      log.warn("utf layer is loading:", isLoading);
      if(isLoading){
        log.error("can not handle the grid utf check when loading, cancel!")
        return false;
      }
      const begin = Date.now();
      let found = false;
      let count = 0;
      let countNoChar = 0;
      const {x,y} = this.map.getSize();
      me: for(let y1 = 0; y1 < y; y1 += 10){
        for(let x1 = 0; x1 < x; x1 +=10){
          count++;
          const tileChar = this.layerUtfGrid._objectForEvent({latlng:this.map.containerPointToLatLng([x1,y1])})._tileCharCode;
          if(!tileChar){
            countNoChar++;
            //log.warn("can not fond char on!:", x1, y1);
            continue;
          }
          const m = tileChar.match(/\d+:\d+:\d+:(\d+)/);
          if(!m) throw new Error("Wrong char:" + tileChar);
          if(m[1] !== "32"){
            log.log("find:", tileChar, "at:", x1,y1);
            found = true;
            break me;
          }
        }
      }
      log.warn("Take time:%d, count:%d,%d,found:%s", Date.now() - begin, count, countNoChar, found);
      return found;
    }



  }

  async unloadTileServer(){
    if(this.map.hasLayer(this.layerTile)){
      this.map.removeLayer(this.layerTile);
    }else{
      log.warn("try to remove nonexisting tile layer"); 
    }
    if(this.map.hasLayer(this.layerUtfGrid)){
      this.map.removeLayer(this.layerUtfGrid);
    }else{
      log.warn("try to remove nonexisting grid layer"); 
    }
  }

  async loadDebugLayer(){
    //debug
    this.L.GridLayer.GridDebug = this.L.GridLayer.extend({
      createTile: function (coords) {
        const tile = document.createElement('div');
        tile.style.outline = '1px solid green';
        tile.style.fontWeight = 'bold';
        tile.style.fontSize = '14pt';
        tile.style.color = 'white';
        tile.innerHTML = [coords.z, coords.x, coords.y].join('/');
        return tile;
      },
    });
    this.L.gridLayer.gridDebug = (opts) => {
      return new this.L.GridLayer.GridDebug(opts);
    };
    this.map.addLayer(this.L.gridLayer.gridDebug());
  }

  async loadTree(treeid){
    const res = await this.requester.request({
      url: `${this.apiServerUrl}tree?tree_id=${treeid}`,
    });
    const {lat, lon, id} = res;
    const data = {
      id,
      lat: parseFloat(lat),
      lon: parseFloat(lon),
    }
    this.selectMarker(data);
    this.onClickTree && this.onClickTree(data);
  }


  highlightMarker(data){
    if(data.type === "point"){
      this.layerHighlight = new this.L.marker(
        [data.lat, data.lon],
        {
            icon: new this.L.DivIcon({
              className: "greenstand-point-highlight",
              html: `
                <div class="greenstand-point-highlight-box"  >
                <div></div>
                </div>
              `,
              iconSize: [32, 32],
            }),
        }
      );
    }else if(data.type === "cluster"){
      this.layerHighlight = new this.L.marker(
        [data.lat, data.lon],
        {
            icon: new this.L.DivIcon({
              className: "greenstand-cluster-highlight",
              html: `
                <div class="greenstand-cluster-highlight-box ${data.count > 1000? '':'small'}"  >
                <div>${Map.formatClusterText(data.count)}</div>
                </div>
              `,
            }),
        }
      );
    }else{
      throw new Error("wrong type:", data);
    }
    this.layerHighlight.addTo(this.map);
  }

  unHighlightMarker(){
    if(this.map.hasLayer(this.layerHighlight)){
      this.map.removeLayer(this.layerHighlight);
    }else{
      log.warn("try to remove nonexisting layer"); 
    }
  }

  clickMarker(data){
    this.unHighlightMarker();
    if(data.type === "point"){
      this.selectMarker(data);
      this.onClickTree && this.onClickTree(data);
    }else if(data.type === "cluster"){
      if(data.zoom_to){
        log.info("found zoom to:", data.zoom_to);
        const [lon, lat] = JSON.parse(data.zoom_to).coordinates;
        //NOTE do cluster click
        if(this.moreEffect){
          this.map.flyTo([lat, lon], this.map.getZoom() + 2);
        }else{
          this.map.setView([lat, lon], this.map.getZoom() + 2, {animate: false});
        }
      }else{
        if(this.moreEffect){
          this.map.flyTo([data.lat, data.lon], this.map.getZoom() + 2);
        }else{
          this.map.setView([data.lat, data.lon], this.map.getZoom() + 2, {animate: false});
        }
      }
    }else{
      throw new Error("do not support type:", data.type);
    }
  }

  selectMarker(data){
    log.info("change tree mark selected");
    //before set the selected tree icon, remote if any
    this.unselectMarker();
    
    //set the selected marker
    this.layerSelected = new this.L.marker(
      [data.lat, data.lon],
      {
        icon: new window.L.DivIcon({
          className: "greenstand-point-selected",
          html: `
            <div class="greenstand-point-selected-box"  >
            <div></div>
            </div>
          `,
          iconSize: [32, 32],
        }),
      }
    );
    this.layerSelected.payload = data;
    this.layerSelected.addTo(this.map);
  }

  unselectMarker(){
    if(this.map.hasLayer(this.layerSelected)){
      this.map.removeLayer(this.layerSelected);
    }else{
      log.warn("try to remove nonexisting layer selected"); 
    }
  }

  async loadInitialView(){
    let view;
    const calculateInitialView = async () => {
      const url = `${this.apiServerUrl}trees?clusterRadius=${Map.getClusterRadius(10)}&zoom_level=10&${this.getFilterParameters()}`;
      log.info("calculate initial view with url:", url);
      const response = await this.requester.request({
        url,
      });
      const view = getInitialBounds(
        response.data.map(i => {
          if(i.type === "cluster"){
            const c = JSON.parse(i.centroid);
            return {
              lat: c.coordinates[1],
              lng: c.coordinates[0],
            };
          }else if(i.type === "point"){
            return {
              lat: i.lat,
              lng: i.lon,
            };
          }
        }),
        this.width,
        this.height,
      );
      return view;
    }
    if(this.filters.userid || this.filters.wallet){
      log.warn("try to get initial bounds");
      view = await calculateInitialView();
    }else if(this.filters.treeid){
      const res = await this.requester.request({
        url: `${this.apiServerUrl}tree?tree_id=${this.filters.treeid}`,
      });
      const {lat, lon} = res;
      view = {
        center: {
          lat,
          lon,
        },
        zoomLevel: 16,
      }
    }else if(this.filters.map_name){
      log.info("to init org map");
      if(mapConfig[this.filters.map_name]){
        const {zoom, center} = mapConfig[this.filters.map_name];
        log.info("there is setting for map init view:", zoom, center);
        view = {
          center: {
            lat: center.lat,
            lon: center.lng,
          },
          zoomLevel: zoom,
        }
      }else{
        view = await calculateInitialView();
      }
    }

    //jump to initial view
    if(view){
      if(this.moreEffect){
        this.map.flyTo(view.center, view.zoomLevel);
        log.warn("waiting initial view load...");
        await new Promise((res, _rej) => {
          const finished = () => {
            log.warn("fire initial view finished");
            this.map.off("moveend");
            res();
          }
          this.map.on("moveend", finished);
        });
      }else{
        this.map.setView(view.center, view.zoomLevel, {animate: false});
      }
    }
  }

  getFilters(){
    const filters = {};
    if(this.filters.userid){
      filters.userid = this.filters.userid;
    }
    if(this.filters.wallet){
      filters.wallet = this.filters.wallet;
    }
    if(this.filters.treeid){
      filters.treeid = this.filters.treeid;
    }
    if(this.filters.timeline){
      filters.timeline = this.filters.timeline;
    }
    if(this.filters.map_name){
      filters.map_name = this.filters.map_name;
    }
    return filters;
  }

  getFilterParameters(){
    const filter = this.getFilters();
    const queryUrl = Object.keys(filter).reduce((a,c) => {
      return `${c}=${filter[c]}` + (a && `&${a}` || "");
    }, "");
    return queryUrl;
  }

//  getClusterRadius(zoomLevel){
//    //old code
//    //var clusterRadius = getQueryStringValue("clusterRadius") || getClusterRadius(queryZoomLevel);
//    return Map.getClusterRadius(zoomLevel);
//  }

  updateUrl(){
    log.warn("update url");
    window.history.pushState('treetrakcer', '', `/?${this.getFilterParameters()}&bounds=${this.getCurrentBounds()}`);
  }

  getCurrentBounds(){
    return this.map.getBounds().toBBoxString();
  }

  getLeafletMap(){
    return this.map;
  }

  goNextPoint(){
    log.info("go next tree");
    const currentPoint = this.layerSelected.payload;
    expect(currentPoint).match({
      lat: expect.any(Number),
    });
    const points = this.getPoints();
    const index = points.reduce((a,c,i) => {
      if(c.id === currentPoint.id){
        return i;
      }else{
        return a;
      }
    },-1);
    if(index !== -1){
      if(index === points.length - 1){
        log.info("no more next");
        return false;
      }else{
        const nextPoint = points[index + 1];
        this.clickMarker(nextPoint);
      }
    }else{
      log.error("can not find the point:", currentPoint, points);
      throw new Error("can not find the point");
    }
  }

  goPrevPoint(){
    log.info("go previous tree");
    const currentPoint = this.layerSelected.payload;
    expect(currentPoint).match({
      lat: expect.any(Number),
    });
    const points = this.getPoints();
    const index = points.reduce((a,c,i) => {
      if(c.id === currentPoint.id){
        return i;
      }else{
        return a;
      }
    },-1);
    if(index !== -1){
      if(index === 0){
        log.info("no more previous");
        return false;
      }else{
        const prevPoint = points[index - 1];
        this.clickMarker(prevPoint);
      }
    }else{
      log.error("can not find the point:", currentPoint, points);
      throw new Error("can not find the point");
    }
  }

  /*
   * To get all the points on the map, (tree markers), now, the way to
   * achieve this is that go through the utf grid and get all data.
   */
  getPoints(){
    //fetch all the point data in the cache
    const itemList = Object.values(this.layerUtfGrid._cache)
      .map(e => e.data).filter(e => Object.keys(e).length > 0)
      .reduce((a,c) => a.concat(Object.values(c)),[])
      .map(data => Map.parseUtfData(data))
      .filter(data => data.type === "point");
    log.info("loaded data in utf cache:", itemList.length);

    //filter the duplicate points
    const itemMap = {};
    itemList.forEach(e => itemMap[e.id] = e);

    //update the global points 
    const points = Object.values(itemMap);
    log.warn("find points:", points.length);
    log.warn("find points:", points);
    return points;
  }

  async rerender(){
    log.info("rerender");
    log.info("reload tile");
    this.unloadTileServer();
    this.loadTileServer();
  }

  /*
   * reset the config of map instance
   */
  setFilters(filters){
    this.filters = filters;
  }

  async loadFreetownLayer(){
    log.info("load freetown layer");
    this.L.TileLayer.FreeTown = this.L.TileLayer.extend({
      getTileUrl: function(coords) {
        const y = Math.pow(2, coords.z) - coords.y - 1;
        const url = `https://treetracker-map-tiles.nyc3.cdn.digitaloceanspaces.com/freetown/${coords.z}/${coords.x}/${y}.png`;
        if (coords.z == 10 && coords.x == 474 && y < 537 && y > 534) {
          return url;
        } else if (coords.z == 11 && coords.x > 947 && coords.x < 950 && y > 1070 && y < 1073) {
          return url;
        } else if (coords.z == 12 && coords.x > 1895 && coords.x < 1899 && y > 2142 && y < 2146) {
          return url;
        } else if (coords.z == 13 && coords.x > 3792 && coords.x < 3798 && y > 4286 && y < 4291) {
          return url;
        } else if (coords.z == 14 && coords.x > 7585 && coords.x < 7595 && y > 8574 && y < 8581) {
          return url;
        } else if (coords.z == 15 && coords.x > 15172 && coords.x < 15190 && y > 17149 && y < 17161) {
          return url;
        } else if (coords.z == 16 && coords.x > 30345 && coords.x < 30379 && y > 34300 && y < 34322) {
          return url;
        } else if (coords.z == 17 && coords.x > 60692 && coords.x < 60758 && y > 68602 && y < 68643) {
          return url;
        } else if (coords.z == 18 && coords.x > 121385 && coords.x < 121516 && y > 137206 && y < 137286) {
          return url;
        }
        return '/';
      }
    });

    this.L.tileLayer.freeTown = () => {
      return new this.L.TileLayer.FreeTown();
    }

    this.L.tileLayer.freeTown(
      '', 
      {
        maxZoom: this.maxZoom,
        tileSize: this.L.point(256, 256)
      }
    ).addTo(this.map);

    axios.get('https://treetracker-map-features.fra1.digitaloceanspaces.com/freetown_catchments.geojson')
      .then(response => {
        expect(response)
          .property("data")
          .property("features")
          .a(expect.any(Array));
        const data = response.data.features;
        const style = {
          color: 'green',
          weight: 1,
          opacity: 1,
          fillOpacity: 0
        };
        this.L.geoJSON(
          data, {
            style: style
          }
        ).addTo(this.map);
      });
  }

  async checkArrow(){
    log.info("check arrow...");
    if(this.layerUtfGrid.hasMarkerInCurrentView()){
      log.info("found marker");
    }else{
      log.info("no marker");
      const nearest = await this.getNearest();
      const placement = this.calculatePlacement(nearest);
      this.onFindNearestAt && this.onFindNearestAt(placement);
    }
  }

  async getNearest(){
    const center = this.map.getCenter();
    log.log("current center:", center);
    const zoom_level = this.map.getZoom();
    const res = await this.requester.request({
      url: `${this.apiServerUrl}nearest?zoom_level=${zoom_level}&lat=${center.lat}&lng=${center.lng}`,
    });
    let {nearest} = res;
    nearest = nearest? {
      lat: nearest.coordinates[1],
      lng: nearest.coordinates[0],
    }:
    undefined;
    log.log("get nearest:", nearest);
    return nearest;
  }

  /*
   * Given a point, calculate the where is it relative to the map view
   * return:
   *  west | east | north | south | in (the point is in the map view)
   */
  calculatePlacement(location){
    const center = this.map.getCenter();
    log.info("calculate location", location, " to center:", center);
    //find it
    //get nearest markers
    expect(location.lat).number();
    expect(location.lng).number();
    let result;
    if(!this.map.getBounds().contains({
      lat: location.lat,
      lng: location.lng,
    })){
      log.log("out of bounds, display arrow");
      const dist = {
        lat: location.lat,
        lng: location.lng,
      };
      const distanceLat = window.L.CRS.EPSG3857.distance(
        center,
        window.L.latLng(
          dist.lat,
          center.lng
        ),
      );
      log.log("distanceLat:", distanceLat);
      expect(distanceLat).number();
      const distanceLng = window.L.CRS.EPSG3857.distance(
        center,
        window.L.latLng(
          center.lat,
          dist.lng,
        ),
      );
      log.log("distanceLng:", distanceLng);
      expect(distanceLng).number();
      log.log("dist:", dist);
      log.log("center:", center, center.lat);
      if(dist.lat > center.lat){
        log.log("On the north");
        if(distanceLat > distanceLng){
          log.log("On the north");
          result = "north";
        }else{
          if(dist.lng > center.lng){
            log.log("On the east");
            result = "east";
          }else{
            log.log("On the west");
            result = "west";
          }
        }
      }else{
        log.log("On the south");
        if(distanceLat > distanceLng){
          log.log("On the south");
          result = "south";
        }else{
          if(dist.lng > center.lng){
            log.log("On the east");
            result = "east";
          }else{
            log.log("On the west");
            result = "west";
          }
        }
      }

    }else{
      result = "in";
    }
    log.info("placement:", result);
    expect(result).oneOf(["north", "south", "west", "east", "in"]);
    return result;
  }

  goto(location){
    log.info("goto:", location);
    this.map.panTo(location);
  }

}
