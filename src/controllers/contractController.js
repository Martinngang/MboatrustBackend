const { Contract } = require('../models');
const { buildCrud } = require('./controllerFactory');

const crud = buildCrud(Contract, { searchableFilters: ['projectId', 'bidId', 'status'] });

module.exports = { getAll: crud.getAll, getOne: crud.getOne, update: crud.update };
