var path = require('path'),
    fs = require('fs'),
    express = require('express'),
    debug = require('debug')('steelmesh-dash'),
    plug = require('plug'),
    swig = require('swig'),
    replimate = require('replimate'),
    _ = require('underscore'),
    server = express.createServer(),
    pathViews = path.resolve(__dirname, '../views'),
    pathStatic = path.resolve(__dirname, '../_static'),
    reLeadingSlash = /^\//,
    _dash = new SteelmeshDashboard(),
    _controllers, _plugger,
    defaultData = {
        title: 'Steelmesh Admin Dashboard',
        apps: {},
        nav: []
    },
    state = {
        status: 'shutdown',
        
        online: false,
        shutdown: true,
        serverup: false
    },
    _pluginLoaders = {},
    _pluginViews = {};
    
function SteelmeshDashboard() {
    // initialise the apps container
    this.apps = {};
    
    // initialise a default config
    this.config = {
        dashboard: {
            port: 3274
        }
    };
    
    // add a placeholder function for the dashboard
    this.log = function() {};
};

SteelmeshDashboard.prototype._detectMode = function(callback) {
    var dashboard = this,
        log = this.log,
        couchUrl = (this.config.admin || {}).url || this.config.url,
        meshdb = this.config.dbname || 'steelmesh';
    
    replimate(couchUrl, function(err, data) {
        if (err) {
            log('error getting replication information from: ' + dashboard.couchurl + err);
        }
        
        // reset the dashboard mode to primary
        dashboard.mode = 'primary';
        
        // iterate through the rows and check if we have replication
        // rules targeting the local steelmesh database
        (data || []).forEach(function(rule) {
            if (rule.target === meshdb) {
                log('detected replication rule targeting meshdb (' + meshdb + ') ', rule);
                
                // if the replication is active (triggered), then mark as a secondary node
                if (rule._replication_state === 'triggered') {
                    log('dashboard set to secondary node mode');
                    dashboard.mode = 'secondary';
                }
            }
        });
        
        if (callback) {
            callback(err, dashboard.mode);
        }
    });
};

SteelmeshDashboard.prototype._getPageData = function(req, page, callback) {
    if (_pluginLoaders[page]) {
        _pluginLoaders[page](req, page, function(data) {
            callback(_.extend({ dash: _dash }, defaultData, state, data));
        });
    }
    else {
        fs.readFile(path.resolve(__dirname, 'pagedata', page + '.json'), 'utf8', function(err, data) {
            callback(_.extend({ dash: _dash }, defaultData, state, data));
        });
    }
}; // _getPageData

SteelmeshDashboard.prototype._initPlugins = function(steelmesh) {
    var dashboard = this;
    
    _controllers = plug.create(server, steelmesh, _dash);
    _plugger = plug.create(server, steelmesh, _dash);
    
    // wire up the messenger
    steelmesh.on('app.load', function(app) {
        if (app.id) {
            dashboard.apps[app.id] = app;
        }

        if (app.basePath) {
            var pluginPath = path.resolve(app.basePath, 'lib', 'plugins', 'dash');
            
            debug('loading application plugins from : ' + pluginPath);
            _plugger.find(pluginPath);
        }
    });
    
    _plugger.on('connect', function(pluginName, pluginData, modulePath) {
        _.extend(_pluginLoaders, pluginData.loaders);
        _.extend(_pluginViews, pluginData.views);

        // add navigation items
        defaultData.nav = defaultData.nav.concat(pluginData.nav || []).sort(function(a, b) {
            return a.title && b.title && a.title > b.title;
        });

        _dash.log('dashboard plugin (' + modulePath + '), loaded successfully');
    });

    _plugger.on('removeNav', function(data) {
        _dash.log('removing nav: ' + data.url);
        defaultData.nav = _.reject(defaultData.nav, function(navItem) {
            return data.url && data.url === navItem.url;
        });
    });

    _plugger.on('dropLoader', function(data) {
        if (data.loader) {
            delete _pluginLoaders[data.loader];
        }
    });

    _plugger.on('dropView', function(data) {
        if (data.view) {
            delete _pluginViews[data.view];
        }
    });
    
    // find the dash plugins
    _plugger.find(path.resolve(__dirname, 'plugins', 'dash'));
};

SteelmeshDashboard.prototype._renderPage = function(req, res, page, baseData, next) {
    var targetPage = path.resolve(pathViews, page),
        dashboard = this;
        
    path.exists(targetPage + '.swig', function(exists) {
        targetPage += exists ? '.swig' : '.html';
        
        dashboard._getPageData(req, page, function(data) {
            var renderData = _.extend({
                page: page,
                messages: req.messages
            }, baseData, data);

            debug('requesting page: ' + targetPage);

            // if the page is a plugin view, then render the template
            if (_pluginViews[page]) {
                res.render(_pluginViews[page], renderData);
            }
            // otherwise, look for one of the existing templates
            else {
                path.exists(targetPage, function(exists) {
                    if (exists) {
                        res.render(targetPage, renderData);
                    }
                    else {
                        next();
                    }
                });
            }
        });
    });
};

SteelmeshDashboard.prototype.start = function(steelmesh, callback) {
    var config = this.config.dashboard || {},
        dashboard = this,
        log = this.log;
        
    steelmesh.on('status', function(newStatus) {
        state.status = newStatus;
        state.online = newStatus === 'online';
    });
    
    this._detectMode(function(err, mode) {
        // initialise the plugin
        dashboard._initPlugins(steelmesh);

        // configure the server
        server.configure(function() {
            swig.init({
                cache: false,
                root: pathViews,
                allowErrors: true 
            });

            server.set('views', pathViews);
            server.register('.html', swig);
            server.set('view engine', 'swig');
            server.set('view options', { layout: false });

            // server.use(express.bodyParser());

            express.favicon();
        });

        // attach status file handler
        server.use(express['static'](pathStatic, { maxAge: config.maxAge || 0 }));

        server.use(function(req, res, next) {
            res.message = function(text, type) {
                res.json({
                    messages: [{ type: type || 'notice', text: text }]
                });
            };

            next();
        });

        // explicitly set the router location
        server.use(server.router);

        // find the controllers
        _controllers.find(path.resolve(__dirname, 'controllers'));

        // handle server routes
        server.use(function(req, res, next) {
            if (req.url === '/') {
                req.url = '/index';
            }

            dashboard._renderPage(req, res, req.url.replace(reLeadingSlash, ''), {}, next);
        });
        
        // listen
        log('starting dashboard express server on port: ' + config.port);
        server.listen(config.port, callback);
    });

};

module.exports = _dash;

