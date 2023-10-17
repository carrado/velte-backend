'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class User extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }

    toJSON() {
      return { ...this.get(), id: undefined }; // Here we hide the id field from being returned during response
    }
  }
  User.init({
    uuid: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4
    },
    name: DataTypes.STRING,
    email: DataTypes.STRING,
    accountType: DataTypes.STRING,
    username: DataTypes.STRING,
    password: DataTypes.STRING,
    subscription: DataTypes.BOOLEAN
  }, {
    sequelize,
    modelName: 'User',
  });
  return User;
};