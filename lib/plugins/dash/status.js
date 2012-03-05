var status = 'unknown';

exports.connect = function(server, steelmesh, dash, callback) {
    server.get('/status', function(req, res) {
        res.json({ status: status });
    });
    
    steelmesh.on('status', function(newStatus) {
        status = newStatus;
    });
    
    callback();
};

exports.drop = function(server, config) {
    server.remove('/status');
};